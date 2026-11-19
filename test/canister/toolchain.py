"""The replica test helpers that come with the build toolchain's Python package"""

# pylint: disable=wildcard-import, unused-wildcard-import, unused-import, useless-import-alias
# the --network and --identity fixtures
from icpp.conftest_base import *  # noqa: F401, F403

# a re-export, for the test modules
from icpp.smoketest import call_canister_api as call_canister_api  # noqa: F401
