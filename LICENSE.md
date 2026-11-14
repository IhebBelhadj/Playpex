# Licence

Playpex is licensed under the **PolyForm Noncommercial License 1.0.0**, given in full below.

In plain words (the licence text below is what counts): you may use, study, change and share Playpex for any
noncommercial purpose, and contribute back (see [CONTRIBUTING.md](CONTRIBUTING.md)). You may not sell it or use it
commercially: no selling copies or changed versions, no paid services or products built on it. Plugins are the
exception: you may write plugins for Playpex and sell them (see "Plugins" below).

Required Notice: Copyright (c) 2026 Iheb Belhadj (https://github.com/IhebBelhadj/Playpex)

Playpex is an educational project. Streaming copyrighted content you don't have the rights to may be illegal where you
live.

## Commercial use

Only Iheb Belhadj may use Playpex commercially or license it for commercial use. If you want to use Playpex
commercially, ask for a commercial licence through https://github.com/IhebBelhadj/Playpex.

## Plugins

Plugins are separate works. As an additional permission from the licensor, on top of the licence below:

1. **A plugin you write is yours.** A plugin here is a package that Playpex loads through its plugin interface (a
   `.ppx` package with a `playpex-plugin.json` manifest), distributed on its own and not as part of Playpex. This
   licence doesn't cover your plugin: you may license it however you like, including selling it, selling access to it,
   or charging for a service it connects to.
2. **Building a plugin is a permitted purpose.** You may use Playpex to make, test, show and support your plugin, even
   when the plugin is sold.
3. **The plugin kit is under the MIT License** (at the end of this file), so a plugin may include or copy it:
   - `plugins/hello/` (the example plugin: start a plugin from it);
   - `docs/plugins/` (the plugin author guide);
   - in `packages/protocol/`: `plugin.schema.json`, `plugin-api.schema.json`, `repository.schema.json`, `plugins.js`,
     `plugins.d.ts`, `signing.js`, `signing.d.ts`.
4. **Everything else stays noncommercial.** A plugin may not include any other part of Playpex. You may not sell
   Playpex, a changed version of it, Playpex bundled with plugins, or a paid service that runs Playpex for others,
   with or without plugins. The plugins Iheb Belhadj ships in `plugins/` (other than `plugins/hello/`) are under this
   licence, or under their own where they say so.

People who buy a plugin may use it with Playpex as the licence below allows (personal and other noncommercial use).

## The Playpex name and logo

This licence covers the code, not the name. "Playpex", the Playpex play mark and the Playpex logo are Iheb Belhadj's and
are not licensed to you. If you share a changed version of Playpex, give it a name and logo of your own and say that it
is based on Playpex by Iheb Belhadj, with a link to https://github.com/IhebBelhadj/Playpex. Don't present Playpex, or a
version of it, as your own work.

## What this licence does not cover

The plugin kit (see "Plugins" above) is under the MIT License, at the end of this file.

These parts are other people's work under their own licences, which apply to them instead (each keeps its licence file):

- `apps/mobile/modules/expo-mpv/`: expo-mpv, vendored, GNU GPL 3.0 (`LICENSE` there).
- `plugins/openscrapers/` and `plugins/thecrew/`: ports of GPL 3.0 Kodi add-ons, GNU GPL 3.0 (`LICENSE` in each).
- `apps/tv/src/plugins/spacialNavigation.js`: js-spatial-navigation, Mozilla Public License 2.0.
- Third-party libraries installed through npm, Go or Cargo, and binaries downloaded at build time (FFmpeg, mpv,
  rqbit), under their own licences.

---

# PolyForm Noncommercial License 1.0.0

<https://polyformproject.org/licenses/noncommercial/1.0.0>

## Acceptance

In order to get any license under these terms, you must agree to them as both strict obligations and conditions to all your licenses.

## Copyright License

The licensor grants you a copyright license for the software to do everything you might do with the software that would otherwise infringe the licensor's copyright in it for any permitted purpose.  However, you may only distribute the software according to [Distribution License](#distribution-license) and make changes or new works based on the software according to [Changes and New Works License](#changes-and-new-works-license).

## Distribution License

The licensor grants you an additional copyright license to distribute copies of the software.  Your license to distribute covers distributing the software with changes and new works permitted by [Changes and New Works License](#changes-and-new-works-license).

## Notices

You must ensure that anyone who gets a copy of any part of the software from you also gets a copy of these terms or the URL for them above, as well as copies of any plain-text lines beginning with `Required Notice:` that the licensor provided with the software.  For example:

> Required Notice: Copyright Yoyodyne, Inc. (http://example.com)

## Changes and New Works License

The licensor grants you an additional copyright license to make changes and new works based on the software for any permitted purpose.

## Patent License

The licensor grants you a patent license for the software that covers patent claims the licensor can license, or becomes able to license, that you would infringe by using the software.

## Noncommercial Purposes

Any noncommercial purpose is a permitted purpose.

## Personal Uses

Personal use for research, experiment, and testing for the benefit of public knowledge, personal study, private entertainment, hobby projects, amateur pursuits, or religious observance, without any anticipated commercial application, is use for a permitted purpose.

## Noncommercial Organizations

Use by any charitable organization, educational institution, public research organization, public safety or health organization, environmental protection organization, or government institution is use for a permitted purpose regardless of the source of funding or obligations resulting from the funding.

## Fair Use

You may have "fair use" rights for the software under the law. These terms do not limit them.

## No Other Rights

These terms do not allow you to sublicense or transfer any of your licenses to anyone else, or prevent the licensor from granting licenses to anyone else.  These terms do not imply any other licenses.

## Patent Defense

If you make any written claim that the software infringes or contributes to infringement of any patent, your patent license for the software granted under these terms ends immediately. If your company makes such a claim, your patent license ends immediately for work on behalf of your company.

## Violations

The first time you are notified in writing that you have violated any of these terms, or done anything with the software not covered by your licenses, your licenses can nonetheless continue if you come into full compliance with these terms, and take practical steps to correct past violations, within 32 days of receiving notice.  Otherwise, all your licenses end immediately.

## No Liability

***As far as the law allows, the software comes as is, without any warranty or condition, and the licensor will not be liable to you for any damages arising out of these terms or the use or nature of the software, under any kind of legal claim.***

## Definitions

The **licensor** is the individual or entity offering these terms, and the **software** is the software the licensor makes available under these terms.

**You** refers to the individual or entity agreeing to these terms.

**Your company** is any legal entity, sole proprietorship, or other kind of organization that you work for, plus all organizations that have control over, are under the control of, or are under common control with that organization.  **Control** means ownership of substantially all the assets of an entity, or the power to direct its management and policies by vote, contract, or otherwise.  Control can be direct or indirect.

**Your licenses** are all the licenses granted to you for the software under these terms.

**Use** means anything you do with the software requiring one of your licenses.

---

# MIT License (the plugin kit)

This applies only to the plugin kit listed under "Plugins" above.

Copyright (c) 2026 Iheb Belhadj

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
