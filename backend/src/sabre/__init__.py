"""SABRE's application package."""

import logging
import os

# The official SDK otherwise records upstream exception strings and request
# bodies. SABRE emits its own content-free execution events and spans instead.
os.environ["OTEL_INSTRUMENTATION_A2A_SDK_ENABLED"] = "false"
logging.getLogger("a2a").setLevel(logging.CRITICAL)

__version__ = "0.1.0"
