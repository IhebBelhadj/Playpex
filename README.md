# <img src="apps/tv/app_icon.svg" alt="" width="40"/> Playpex

Playpex keeps your films and shows on a computer at home and plays them on your TV, your phone and in any browser on your Wi-Fi.

<a href="https://www.youtube.com/watch?v=mj4EjDdVXTo" target="_blank">
  <img src="https://lh3.googleusercontent.com/fife/ALs6j_F4HTHgkJP8ZGHWvr_ZVBSp5mJIAqxM4FZYs0lntlLTz_fSOKHJf5YNyQMMrgBBLMDrMjilq1rm52AvDELuYlRYWg4azJ3j-QHABydFMGVyB5D4nD8DJ5qh1Na9OFoKtUjB4b8mQ-y142StzuFiof6OOV9jO8XWfChyszdKOn3sam-KrlMtU4hmkr51QHbGfXqKpgew-nGEBz9eTGbnc0QkSsZyjj0RK1NsGLxIowu7HwiO-ZHDb0VXYYNzGbjle2WqzoNIFH3vA7G9NUxP80td7_GsNxRZwcMpWMid09cC8i_EmxTq04vXRCg-SApkhdjg6g0c1dQ1_Tp4mYsEL_1cCQVy8xjOxQLi0B07LfcCBzvLcL3qAGL_lkQPB6BrXhCfhEHjNNun_z56tLBRFoJBOY_cUnIY-KSWcDrbNKcW9M96v0HUhw9DpViF4f9JgwDOr0YDVjFnCgMj7v0IzqaiFzkvBDmjClSrxxUIBBze7Y9N_5haKAoH5UbqtJD56BM15evfkd93fA4OOgBzy6CeS5m9klX-85gUFS8L8Wm9yyB6G-SUTw3KYy7gVNTRZ1TArL4o8VF237m-JkOpki4mhS5j9mNIJVRkHijLFVRk9HUILYHZxqza3OSvHrv9B8pisIy7VYRS4GOjtLkU42_o6DMXGU5-oEV72pi5gIiVXFL4oy8iJiY1p7-TocarI75oehjAciVxGhgkzSwp1u8dlej8f7HasJL-29VkJBm8umAs0l6CozwcgcqoYW90zhPVVkF3jwi16M9S4NpMAlQt9o0y00wU7FF5sXaa_WcMV1poC4genUHe9EkBwG3jRp2dcgbPXvJC4_E8fwkXOL4hSNDhf3MyqIMRDXQ8Tuu1YDbGesi4G2mpwixkIaHe-1lncgFfQyYhbDYaWLA1ALIxHZ2LVik-k9P0GEcEhu_sNkU8V4DBep2H5nhUB7mZgJkNEsq1JSD5zY6ysOWQENXWKZ2puYm0Lv1pv4o_NDr14sm4x5ctawbRIM7UM2cEioVDA5BcUMB-oWutJWRXjI8dAVayyS5beWh1IccafSYZXwPLmbSsZzodLgOgacpmJqcnKvLAlyym7FlO7X-3entq9NsBumpFceK0LoR83GrIce0rVsgrrAXLd5gyGngM3QYBo_mlNVmeo07WilS9-NtddO9SMzTfwOZ4gKK0JSit3f9CVKgw6qzDokTrvrnnNH5FrV0cAPUMTmu1z_kRzIKArv6TwBwxye_bQ2yfmU2t3Vxabr-UmIdM_1OGeogd1UZqgITPQIiRD_I13onF9Xq8u7mNbGJnvmOAE8x6igjfUdAftsk9FezFrwtJUsce5NaIrLYIQWyrum_5HI7e4ilwcc7SpCmCVXErNBRYAjlinACnwrq34Wlq0_6gzs_vZkGn8nv9n6LJGJtXZHVWxcf0QR4q4qiKDR3a2Cc5IdXAvjjoXGZCALaB8EC5Kecx6HOY73ZgUgzbNw2_y8HEpDmbSBHNL0xsx5rAqyuP-WTKSrterbQQsRoPu61uIJQTVJ7JXtQvTvqOBCGof-t1ElEN6Hf3g3xv7HcrS_ei0kfaITt2jixfuIbebfwDlvpi2P9OtxvQHrLZ9TtroVU" alt="Watch the Playpex promo video on YouTube">
</a>

## The apps

| App | What it does | Runs on |
|---|---|---|
| **Playpex Media Server** | Keeps your library and downloads, streams them to every screen. Run it from its dashboard in a browser. | Windows, macOS, Linux |
| **Playpex TV** | The big-screen app, made for a remote: arrows, OK and Back. | Windows, macOS, Linux |
| **Playpex Mobile** | Your library on your phone, with every audio track and subtitle. | Android (iOS later) |
| **Server Manager** | Finds your server on the Wi-Fi and opens its dashboard on your phone. | Android |

Install the server once; the other apps find it on your network.

## Download

Get the latest version from [Releases](https://github.com/IhebBelhadj/Playpex/releases).

## Run from source

Needs Node.js 22 or later.

```sh
npm install
npm run server      # the media server, then open http://localhost:28470
npm run electron    # Playpex TV
```

## Plugins

Sources, subtitles, live TV and metadata come from plugins, installed from the server's dashboard. To write one, see [docs/plugins](docs/plugins/README.md).

## Disclaimer

Playpex is an educational project, not for commercial use. Streaming copyrighted content you don't have the rights to may be illegal where you live. See [licence.md](licence.md).
