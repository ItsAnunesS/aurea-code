"""Verify the update contract before publishing an AppImage release."""
import hashlib
import os
import pathlib
import subprocess
import sys

path = pathlib.Path(sys.argv[1]).resolve()
expected = 'gh-releases-zsync|ItsAnunesS|aurea-code|latest|Aurea-Code-*-x86_64.AppImage.zsync'
environment = dict(os.environ)
environment.pop('APPIMAGE_EXTRACT_AND_RUN', None)
actual = subprocess.check_output([str(path), '--appimage-updateinformation'], text=True, env=environment).strip()
assert actual == expected, f'Unexpected update information: {actual}'
with path.open('rb') as stream:
    assert stream.read(4) == b'\x7fELF', 'Not an ELF AppImage'
    stream.seek(0)
    digest = hashlib.file_digest(stream, 'sha1').hexdigest()
header = pathlib.Path(str(path) + '.zsync').read_bytes().split(b'\n\n', 1)[0].decode()
fields = dict(line.split(': ', 1) for line in header.splitlines() if ': ' in line)
assert fields['Filename'] == path.name
assert int(fields['Length']) == path.stat().st_size
assert fields['SHA-1'] == digest, 'zsync digest does not match AppImage'
version = path.name.removeprefix('Aurea-Code-').removesuffix('-x86_64.AppImage')
assert fields['URL'] == f'https://github.com/ItsAnunesS/aurea-code/releases/download/v{version}/{path.name}'
print('Gear Lever metadata, asset name, URL, length and zsync digest verified.')
