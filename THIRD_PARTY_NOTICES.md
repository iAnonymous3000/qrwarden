# Third-party notices

QRWarden's original source code and documentation are licensed under AGPL-3.0-or-later except where a file says otherwise. Third-party packages and analyzer data retain their upstream copyright and license terms. [DEPENDENCIES.md](DEPENDENCIES.md) records their versions, sources, and provenance.

This repository notice is an index, not the normative release license report. Before any public artifact is released, the pinned license generator must enumerate the installed lockfile graph and every bundled non-npm data component, normalize and hash the selected `LICENSE*`, `COPYING*`, and `NOTICE*` texts, and emit the deterministic full-text `qrwarden-X.Y.Z-licenses.txt`. Missing, ambiguous, non-UTF-8, incompatible, or forbidden licensing blocks release unless an exact reviewed entry in `release/license-overrides.json` resolves an npm-package anomaly. An empty selected-text list is permitted only when that exact published package contains no eligible root text; optional native-package overrides must still match the authoritative lockfile.

Source URLs, versions, and declared licenses for direct dependencies are recorded in `DEPENDENCIES.md`. Eligible package-root and bundled-data license texts are reproduced in the generated release license report; exact npm-package omissions are recorded by reviewed override.

## Public Suffix List

The vendored Public Suffix List and its generated analyzer snapshot derive from the `publicsuffix/list` project. The source file carries the project's notice and remains subject to the Mozilla Public License 2.0. A verified offline copy is stored at [data-src/psl/LICENSE](data-src/psl/LICENSE); the [upstream MPL 2.0 page](https://www.mozilla.org/MPL/2.0/) is a secondary reference. QRWarden's AGPL license does not replace those terms.

## IANA protocol registries

The vendored IANA IPv4 and IPv6 registry data is covered by the [joint IANA/IETF registry-data statement](https://www.iana.org/help/licensing-terms), which applies the Creative Commons CC0 1.0 public-domain dedication and its accompanying disclaimer to the protocol registries. A verified offline copy of the legal code is stored at [data-src/iana/CC0-1.0.txt](data-src/iana/CC0-1.0.txt).

## Unicode Data Files

The exact notice below accompanies the vendored and generated Unicode 17 data. A byte-identical copy is stored at `data-src/unicode/license.txt`.

### UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
