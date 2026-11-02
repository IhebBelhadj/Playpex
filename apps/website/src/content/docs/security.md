---
title: "Security"
description: "The rules every plugin runs under, and why."
group: Build plugins
order: 7
---

A plugin is code the server's owner didn't write. These rules hold by construction: the plugin has no other way to act.

| Rule | Because |
|---|---|
| Plugin code runs only in a sandbox on the server, with nothing but `playpex` | the server runs as its user, with their files |
| No plugin code in the apps; screens are templates fed with data | the apps hold the device's credentials |
| Every capability is a permission, shown to the admin in words, and asked again when it grows | installing is consent; an update can't add power silently |
| Network: HTTPS to declared host names, public addresses only, checked on every redirect | the server sits on your home network, beside routers and NAS boxes |
| Requests are rate limited per host | a plugin hammering a site gets your address banned |
| `http` sources are proxied; apps never see the URL or headers | tokens of paid services stay on the server |
| The context carries a profile id and kids flag, never tokens or other profiles | people's data stays theirs |
| Personal permissions are granted per profile, off until switched on | what someone watches isn't the admin's to send anywhere |
| Answers are checked against a schema; a bad answer is a failed handler | the server never acts on malformed data |
| Hooks only add, reorder, or hide with a reason the user sees | a plugin can't silently take over Play |
| Limits per plugin: memory, CPU per call, calls at once, queued events | a broken plugin can't take the server down |
| Packages come signed, from a repository or a trusted publisher; unsigned ones only in developer mode | you know who wrote what you install |
| A plugin updates only from the repository it came from | another repository can't take over an id |
| Setup, grants and linking happen only on the dashboard | a screen, or whoever holds one, can't change what plugins may do |
