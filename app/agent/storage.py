"""R5: serialize issue writers and publish complete files without exposing partial writes."""

import errno
import hashlib
import os
import shutil
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path

_THREAD_LOCKS: dict[str, threading.Lock] = {}
_REGISTRY_LOCK = threading.Lock()


@contextmanager
def issue_lock(out_dir: Path, issue_date, timeout: float = 10):
    """Advisory locks release on process exit; persistent empty lock files are harmless."""
    key = hashlib.sha256(
        f"{os.path.normcase(str(out_dir.resolve()))}|{issue_date}".encode()
    ).hexdigest()
    with _REGISTRY_LOCK:
        local_lock = _THREAD_LOCKS.setdefault(key, threading.Lock())
    deadline = time.monotonic() + timeout
    if not local_lock.acquire(timeout=max(0.0, timeout)):
        raise ValueError("Выпуск уже рассчитывается; повторите запрос после его завершения")
    try:
        directory = Path(tempfile.gettempdir()) / "windcast-issue-locks"
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / f"{key}.lock").open("a+b") as stream:
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()
            acquired = False
            try:
                while not acquired:
                    try:
                        stream.seek(0)
                        if os.name == "nt":
                            import msvcrt

                            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                        else:
                            import fcntl

                            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        acquired = True
                    except OSError as exc:
                        if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                            raise
                        if time.monotonic() >= deadline:
                            raise ValueError("Выпуск уже рассчитывается другим процессом") from exc
                        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
                yield
            finally:
                if acquired:
                    stream.seek(0)
                    if os.name == "nt":
                        import msvcrt

                        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    finally:
        local_lock.release()


def publish_files(files: list[tuple[Path, Path]]) -> None:
    """Prepare complete replacements first, commit CSV last, roll back ordinary I/O failures.

    Every temporary file is on its destination filesystem for atomic os.replace, including
    Windows. Existing files remain readable while the calculation or preparation is running.
    """
    prepared = []
    replaced = []
    temporary = []
    try:
        for source, target in files:
            target.parent.mkdir(parents=True, exist_ok=True)

            def copy_temporary(path, destination_dir=target.parent):
                fd, name = tempfile.mkstemp(prefix=".publish-", dir=destination_dir)
                os.close(fd)
                copy = Path(name)
                temporary.append(copy)
                shutil.copyfile(path, copy)
                return copy

            replacement = copy_temporary(source)
            backup = copy_temporary(target) if target.exists() else None
            prepared.append((target, replacement, backup))
        for target, replacement, backup in prepared:
            replacement.replace(target)
            replaced.append((target, backup))
    except Exception:
        for target, backup in reversed(replaced):
            if backup is None:
                target.unlink(missing_ok=True)
            else:
                backup.replace(target)
        raise
    finally:
        for path in temporary:
            path.unlink(missing_ok=True)
