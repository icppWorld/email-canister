ARG IMAGE
FROM --platform=linux/amd64 ${IMAGE}

# Part of the artifact: sources are compiled with absolute paths, so this
# directory can end up in the wasm. Changing it can change the hash.
WORKDIR /app/email-canister

# Only what the build reads
COPY icpp.toml Makefile version.txt ./
COPY src ./src/
COPY shims ./shims/
COPY vendor ./vendor/
COPY scripts/build_wasm_docker.sh ./scripts/

CMD ["/bin/bash"]
