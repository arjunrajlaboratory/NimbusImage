import sys
import json
import time


def sendProgress(progress, title, info):
    """
    Send progress to the front end

    :param float progress: Progress between 0 and 1 for the linear progress bar
    :param str title: Text to show in bold in the progress bar
    :param str info: Text to show after the title in the progress bar
    """
    print(json.dumps({"progress": progress, "title": title, "info": info}))
    sys.stdout.flush()


def sendWarning(warning_message, title="Warning", info=None):
    """
    Send warning message to the front end

    :param str warning_message: The warning message to send
    :param str title: Title for the warning message
    :param str info: Additional information to send
    """
    print(json.dumps({
        "warning": warning_message,
        "title": title,
        "info": info,
        "type": "warning"
    }))
    sys.stdout.flush()


def sendError(error_message, title="Error", info=None):
    """
    Send error message to the front end

    :param str error_message: The error message to send
    :param str title: Title for the error message
    :param str info: Additional information to send
    """
    print(json.dumps({
        "error": error_message,
        "title": title,
        "info": info,
        "type": "error"
    }))
    sys.stdout.flush()


def sendHeartbeat():
    """Sends a heartbeat message to keep the connection alive."""
    print(json.dumps({"type": "heartbeat"}))
    sys.stdout.flush()


def heartbeatLoop(interval=30):
    """
    Loops a heartbeat message to keep the connection alive.

    :param int interval: The interval in seconds between heartbeats

    Usage from within a worker:
    heartbeat_thread = threading.Thread(target=heartbeatLoop, daemon=True)
    heartbeat_thread.start()
    """
    while True:
        time.sleep(interval)
        sendHeartbeat()
