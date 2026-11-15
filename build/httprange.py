"""Seekable read-only file over HTTP range requests, so h5py can read a small window of a multi-gigabyte file
in NASA's archive without downloading it. Needs a free Earthdata login (https://urs.earthdata.nasa.gov).
"""
import io
import time

import earthaccess

BLOCK = 2 * 1024 * 1024


class HttpRangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests, with a small block cache."""

    def __init__(self, session, url, block=BLOCK, max_blocks=64):
        self.session, self.url, self.pos, self.cache = session, url, 0, {}
        self.block, self.max_blocks = block, max_blocks
        self.requests_made = self.bytes_fetched = 0
        r = session.get(url, headers={"Range": "bytes=0-0"}, timeout=120)
        self.first_status = r.status_code
        r.raise_for_status()
        if r.status_code != 206:
            raise OSError(f"server ignored range request (HTTP {r.status_code})")
        self.size = int(r.headers["Content-Range"].split("/")[-1])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=io.SEEK_SET):
        self.pos = offset if whence == io.SEEK_SET else (self.pos + offset if whence == io.SEEK_CUR else self.size + offset)
        return self.pos

    def _block(self, i):
        if i not in self.cache:
            start = i * self.block
            end = min(start + self.block, self.size) - 1
            for attempt in range(4):  # retry 5xx
                r = self.session.get(self.url, headers={"Range": f"bytes={start}-{end}"}, timeout=300)
                if r.status_code < 500:
                    break
                time.sleep(2 * (attempt + 1))
            r.raise_for_status()
            self.cache[i] = r.content
            self.requests_made += 1
            self.bytes_fetched += len(r.content)
            if len(self.cache) > self.max_blocks:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[i]

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        done = 0
        while done < n:
            i, off = divmod(self.pos, self.block)
            chunk = self._block(i)[off: off + (n - done)]
            b[done: done + len(chunk)] = chunk
            done += len(chunk)
            self.pos += len(chunk)
        return done


def session():
    earthaccess.login()  # uses saved _netrc
    return earthaccess.get_requests_https_session()
