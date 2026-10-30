"""Commit a prepared immutable baseline without leaving dangling Store links."""
import asyncio
import json
from pathlib import Path
import shutil

from .native import NativeError


async def settle(awaitable):
    """Finish owned work after caller cancellation; accept HA executor Futures."""
    task = asyncio.ensure_future(awaitable)
    cancelled = False
    while True:
        try:
            return await asyncio.shield(task), cancelled
        except asyncio.CancelledError:
            cancelled = True
            if task.cancelled():
                raise


def _stored_document(native):
    # A load cache cannot establish whether rename committed before fsync failed.
    try:
        path = Path(native.store.path)
        if path.is_symlink() or path.parent.is_symlink() or not path.is_file():
            return None
        with path.open('rb') as stream:
            raw = stream.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            return None
        value = json.loads(raw)
        return value.get('data') if isinstance(value, dict) else None
    except (AttributeError, OSError, ValueError, TypeError):
        return None


def _same_document(left, right):
    try:
        return json.dumps(left, sort_keys=True, separators=(",", ":"), allow_nan=False) == json.dumps(
            right, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError):
        return False


async def commit_baseline(native, previous, updated, identifier, accept):
    """Discard the copy only when disk proves the old document survived.

    The caller holds its project lock and has finished source/authority checks.
    accept() synchronously updates memory after a confirmed durable commit.
    """
    native._baseline_recovery_required = True
    try:
        _, cancelled = await settle(native.store.async_save(updated))
    except asyncio.CancelledError:
        # Cancellation of the Store task itself can leave an executor writing.
        # Retain both baselines so a reload can resolve the durable outcome.
        raise
    except Exception as error:
        durable = await native.hass.async_add_executor_job(_stored_document, native)
        if _same_document(durable, updated):
            accept()
            native._baseline_recovery_required = False
            raise NativeError('baseline_commit_saved', 'The new baseline was saved, but storage confirmation failed. Reload the saved draft before continuing; both baselines are retained.') from error
        if _same_document(durable, previous):
            await native.hass.async_add_executor_job(shutil.rmtree, native.root / 'baselines' / identifier)
            native._baseline_recovery_required = False
            raise NativeError('baseline_save_failed', 'The baseline change could not be saved. The original draft and published home are unchanged.') from error
        raise NativeError('baseline_commit_uncertain', 'The saved outcome could not be confirmed. Both baselines are retained. Restart Home Assistant before loading the saved draft or retrying.') from error
    accept()
    native._baseline_recovery_required = False
    if cancelled:
        raise asyncio.CancelledError
