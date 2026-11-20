# Builds and tests. The toolchain is icpp-pro (see requirements.txt); its
# commands appear only here and in the build files.
#
# First time:     make build-all build-relay-stub
# Day to day:     make build build-test
# After changing vendor/, shims/ or src/store/sqlite_vfs.c: make build-libraries

SHELL := /bin/bash
TEST_IDENTITY ?= email-canister-test
LIBRARIES := sqlite3 libetpan charsets

.PHONY: build-all build-libraries build build-test build-relay-stub \
	test test-python test-native test-domain test-canister test-e2e test-bridge check-neutral webmail

# Everything, including the libraries and the toolchain's own: slow
build-all:
	icpp build-wasm
	icpp build-wasm --to-compile mine-no-lib --config icpp-test.toml

build-libraries:
	for lib in $(LIBRARIES); do icpp build-library $$lib || exit 1; done

# Our own code only; links the libraries built above
build:
	icpp build-wasm --to-compile mine-no-lib

# The test build adds hooks that inject failures; never deploy it
build-test:
	icpp build-wasm --to-compile mine-no-lib --config icpp-test.toml

build-relay-stub:
	cd test/relay_stub && icpp build-wasm

# The generic build, configured into build/webmail, which icp.yaml deploys:
#   make webmail BACKEND=<backend id> [NETWORK=local|ic] [ORIGIN=https://…] [BRAND=<folder>]
NETWORK ?= local
webmail:
	@test -n "$(BACKEND)" || { echo "Usage: make webmail BACKEND=<backend id> [NETWORK=local|ic] [ORIGIN=https://…] [BRAND=<folder>]"; exit 1; }
	cd webmail && npm ci && npm run build
	node webmail/brand/brand.mjs --dist webmail/dist --out build/webmail --backend $(BACKEND) --network $(NETWORK) \
	  $(if $(ORIGIN),--origin $(ORIGIN)) $(if $(BRAND),--brand $(BRAND))

test: test-python test-native test-domain test-canister test-e2e

# Needs no replica
test-python:
	pytest test/test_build_config.py test/test_charsets.py

# Needs no replica: the test build on icpp's Mock IC, as a native executable
# (native/), in seconds. The libraries are built natively once, and again
# after icpp-test.toml or a library's sources change, another toolchain
# version is installed, or a build failed. The stamp holds the version that
# built them.
NATIVE_LIBRARY_INPUTS := icpp-test.toml vendor shims src/store/sqlite_vfs.c
test-native:
	version="$$(icpp --version)"; \
	if [ -f build-library-native/built ] && \
	   [ -z "$$(find $(NATIVE_LIBRARY_INPUTS) -newer build-library-native/built | head -1)" ] && \
	   [ "$$(cat build-library-native/built)" = "$$version" ]; then to=mine-no-lib; else to=all; fi; \
	  icpp build-native --config icpp-test.toml --to-compile $$to && \
	  echo "$$version" > build-library-native/built
	./build-native/mockic.exe

# Needs no replica: domain/domain.mjs, with Node's own test runner
test-domain:
	node --test test/domain/*.test.mjs

# Needs a local replica: icp network start -d
test-canister:
	pytest --network=local --identity=$(TEST_IDENTITY) test/canister

test-e2e:
	TEST_IDENTITY=$(TEST_IDENTITY) bash webmail/e2e/setup.sh
	cd webmail && npm run e2e

# The relay bridge (bridge/) in a Caffeine-style app on PocketIC. Needs only
# Docker: it runs in a pinned container
test-bridge:
	test/bridge/run.sh

check-neutral:
	scripts/check-neutral.sh

# ---------------------------------------------------------------------------
# Static checks: formatters, linters and type checkers.
#   make all-static     formats in place, then lints: before a commit
#   make check-static   changes nothing and fails on any finding, as CI does
# clang-format comes with the toolchain's wasi-sdk. libetpan's code in shims/
# and the generated charset tables keep their own layout.
ifndef CLANG_FORMAT
CLANG_FORMAT := $(shell python -c "from icpp import config_default as c; print(c.WASI_SDK_COMPILER_ROOT / 'bin/clang-format')")
endif
CPP_FILES := $(filter-out shims/charset_tables.% shims/mailmime_helpers.c, \
	$(wildcard src/*/*.cpp src/*/*.h src/*/*.c native/*.cpp native/*.h \
	  test/relay_stub/*.cpp shims/*.c shims/*.h))
PYTHON_DIRS := test tools

.PHONY: all-static check-static cpp-format cpp-format-check python-format python-format-check \
	python-lint python-type webmail-format webmail-format-check webmail-lint webmail-type \
	clang-format-found

all-static: cpp-format python-format webmail-format python-lint python-type webmail-lint webmail-type

check-static: cpp-format-check python-format-check webmail-format-check \
	python-lint python-type webmail-lint webmail-type

cpp-format: clang-format-found
	$(CLANG_FORMAT) --style=file -i $(CPP_FILES)

cpp-format-check: clang-format-found
	$(CLANG_FORMAT) --style=file --dry-run --Werror $(CPP_FILES)

clang-format-found:
	@command -v "$(CLANG_FORMAT)" >/dev/null || { echo "no clang-format at '$(CLANG_FORMAT)': activate the Python env with the toolchain, then run: icpp install-wasi-sdk"; exit 1; }

python-format:
	python -m black $(PYTHON_DIRS)

python-format-check:
	python -m black --check $(PYTHON_DIRS)

# test/ is not a package, so pylint gets its files
python-lint:
	python -m pylint --jobs=0 --rcfile=.pylintrc test/*.py test/canister tools

python-type:
	python -m mypy --config-file .mypy.ini --strict $(PYTHON_DIRS)

webmail-format:
	cd webmail && npm run format

webmail-format-check:
	cd webmail && npm run format:check

webmail-lint:
	cd webmail && npm run lint

# The app, and the e2e tests with the build configs
webmail-type:
	cd webmail && npm run typecheck

# ---------------------------------------------------------------------------
# Reproducible builds, as a release makes them. Results go to out/.
#   make docker-build-base      once: the pinned toolchain image (slow)
#   make docker-build           the wasm and the webmail, with their hashes
#   make release-zip            out/email-canister_v<version>.zip
COMPOSE := docker compose -f docker/docker-compose.yml
# Recorded in the provenance; -dirty when tracked files differ from the commit
export SOURCE_COMMIT := $(shell git rev-parse HEAD)$(shell git diff --quiet HEAD -- || echo -dirty)
# The canister docker-verify-wasm compares against
VERIFY_CANISTER ?=
VERIFY_NETWORK ?= ic

.PHONY: docker-build-base docker-build docker-build-wasm docker-build-webmail docker-verify-wasm docker-shell release-zip

docker-build-base:
	$(COMPOSE) build base

docker-build: docker-build-wasm docker-build-webmail

docker-build-wasm:
	@# Docker's bind mount tags out/ with an extended attribute; on a drive
	@# without native attributes (exFAT) the next build cannot send the context
	@if command -v xattr >/dev/null && test -d out; then xattr -c out; rm -f ._out; fi
	@# Created here, or Docker creates it owned by root on Linux
	mkdir -p out
	$(COMPOSE) build --no-cache wasm && $(COMPOSE) run --rm wasm

docker-build-webmail:
	mkdir -p out
	$(COMPOSE) run --rm webmail

# Rebuilds the wasm and compares it with what a canister runs
docker-verify-wasm: docker-build-wasm
	@test -n "$(VERIFY_CANISTER)" || { echo "Usage: make docker-verify-wasm VERIFY_CANISTER=<canister id>"; exit 1; }
	@deployed=$$(icp canister status $(VERIFY_CANISTER) --network $(VERIFY_NETWORK) --public 2>/dev/null | sed -n 's/.*[Mm]odule hash: *\(0x\)\{0,1\}\([0-9a-f]\{64\}\).*/\2/p'); \
	built=$$(cat out/email-canister.wasm.sha256); \
	echo "built:    $$built"; echo "deployed: $$deployed"; \
	test "$$built" = "$$deployed" && echo "match" || { echo "MISMATCH"; exit 1; }

docker-shell:
	$(COMPOSE) run --rm --entrypoint /bin/bash wasm

release-zip:
	scripts/make-release-zip.sh
