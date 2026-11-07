"""Verify the update contract before publishing an AppImage release."""
import configparser
import tempfile
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
with tempfile.TemporaryDirectory(prefix='aurea-appimage-metadata-') as directory:
    subprocess.run([str(path), '--appimage-extract', '*.desktop'], cwd=directory,
                   env=environment, stdout=subprocess.DEVNULL, check=True)
    subprocess.run([str(path), '--appimage-extract', 'usr/bin/aurea-ide'], cwd=directory,
                   env=environment, stdout=subprocess.DEVNULL, check=True)
    ide = pathlib.Path(directory) / 'squashfs-root/usr/bin/aurea-ide'
    assert ide.is_file() and os.access(ide, os.X_OK), 'Standalone IDE executable is missing from AppImage'
    desktop_files = list((pathlib.Path(directory) / 'squashfs-root').glob('*.desktop'))
    assert len(desktop_files) == 1, 'Expected exactly one root desktop entry'
    entry = configparser.ConfigParser(interpolation=None, strict=True)
    entry.optionxform = str
    assert entry.read(desktop_files[0]), 'Unable to read bundled desktop entry'
    embedded_version = entry['Desktop Entry'].get('X-AppImage-Version')
    assert embedded_version == version, f'Gear Lever version mismatch: {embedded_version!r} != {version!r}'
print(f'Gear Lever version {version}, update metadata, asset name, URL, length and zsync digest verified.')
