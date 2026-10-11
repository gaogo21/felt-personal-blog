#!/usr/bin/env python3
"""Generate provenance/license notices from restored NuGet package metadata."""
import json, pathlib, xml.etree.ElementTree as ET
root=pathlib.Path(__file__).resolve().parents[1]
assets=json.loads((root/'src/Blog.Web/obj/project.assets.json').read_text())
cache=pathlib.Path(next(iter(assets['packageFolders'])))
rows=[];texts={}
for full,value in sorted(assets['libraries'].items()):
    if value['type']!='package':continue
    path=cache/value['path'];spec=next(path.glob('*.nuspec'));tree=ET.parse(spec)
    find=lambda name: next((n for n in tree.iter() if n.tag.split('}')[-1]==name),None)
    license=find('license');repo=find('repository');url=find('licenseUrl')
    label=license.text if license is not None else 'See package license URL'
    rows.append(f'| {full} | {label} | {repo.attrib.get("url","") if repo is not None else url.text if url is not None else ""} |')
    candidates=[f for f in path.rglob('*') if f.is_file() and f.name.lower() in ['license','license.txt','license.md']]
    if license is not None and license.attrib.get('type')=='file':candidates.append(path/license.text)
    for file in candidates:
        text=file.read_text(errors='replace').strip();texts.setdefault(text,[]).append(full)
for file in sorted((root/'docs/third-party').glob('*-LICENSE.txt')):
    texts.setdefault(file.read_text().strip(),[]).append(file.stem)
body='# Backend dependencies\n\nGenerated from restored NuGet metadata; versions and hashes are locked in `src/Blog.Web/packages.lock.json`. Runtime package source and license metadata follow. Build-only EF tools and Roslyn dependencies are included for completeness. The .NET container base retains its own runtime notices.\n\n| Package/version | License metadata | Source |\n|---|---|---|\n'+'\n'.join(rows)+'\n\nEmbedded package license files:\n\n'+'\n\n'.join('### '+', '.join(sorted(set(names)))+'\n\n'+text for text,names in texts.items())+'\n'
body+='\nAdditional runtime license sources: [Npgsql 10.0.3 source license](https://github.com/npgsql/npgsql/blob/d3768398c17877b3a916c3c4d87e8e11698991fc/LICENSE), [EF Core source license](https://github.com/dotnet/efcore/blob/main/LICENSE.txt). Copies are preserved under docs/third-party and in the published THIRD_PARTY_NOTICES.txt.\n'
(root/'docs/dependencies.md').write_text(body)
(root/'src/Blog.Web/THIRD_PARTY_NOTICES.txt').write_text(body)
print(f'Recorded {len(rows)} NuGet packages and {len(texts)} unique embedded license texts.')
