#!/usr/bin/env python3
"""Verify selected historical bodies directly against the preserved Git archive."""
import hashlib, io, json, pathlib, subprocess, zipfile
root=pathlib.Path(__file__).resolve().parents[1]
manifest=json.loads((root/'docs/recovery-sources.json').read_text())
blob=subprocess.check_output(['git','show',manifest['archiveCommit']+':felt-backend-records-20261011.zip'],cwd=root)
assert hashlib.sha256(blob).hexdigest()==manifest['archiveSha256'],'Archive hash mismatch'
archive=zipfile.ZipFile(io.BytesIO(blob));assert archive.testzip() is None,'Archive CRC mismatch'
for entry in manifest['files']:
    body=archive.read('felt-backend-records-20261011/'+entry['source'])
    assert hashlib.sha256(body).hexdigest()==entry['originalSha256'],entry['source']
    current=(root/entry['destination']).read_bytes()
    print(('unchanged' if body==current else 'adapted')+' '+entry['destination'])
print(f"Verified {len(manifest['files'])} original bodies and archive SHA-256; current adaptations are versioned in Git.")
