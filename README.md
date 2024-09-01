# <img src="https://i.ibb.co/wSwD1nB/logo-1.png" alt="Playpex logo" width="50"/> Playpex

Playpex is a media streaming platform with a 10-foot user interface with spacial navigation

<a href="https://www.youtube.com/watch?v=mj4EjDdVXTo" target="_blank">
  <img src="https://lh3.googleusercontent.com/fife/ALs6j_F4HTHgkJP8ZGHWvr_ZVBSp5mJIAqxM4FZYs0lntlLTz_fSOKHJf5YNyQMMrgBBLMDrMjilq1rm52AvDELuYlRYWg4azJ3j-QHABydFMGVyB5D4nD8DJ5qh1Na9OFoKtUjB4b8mQ-y142StzuFiof6OOV9jO8XWfChyszdKOn3sam-KrlMtU4hmkr51QHbGfXqKpgew-nGEBz9eTGbnc0QkSsZyjj0RK1NsGLxIowu7HwiO-ZHDb0VXYYNzGbjle2WqzoNIFH3vA7G9NUxP80td7_GsNxRZwcMpWMid09cC8i_EmxTq04vXRCg-SApkhdjg6g0c1dQ1_Tp4mYsEL_1cCQVy8xjOxQLi0B07LfcCBzvLcL3qAGL_lkQPB6BrXhCfhEHjNNun_z56tLBRFoJBOY_cUnIY-KSWcDrbNKcW9M96v0HUhw9DpViF4f9JgwDOr0YDVjFnCgMj7v0IzqaiFzkvBDmjClSrxxUIBBze7Y9N_5haKAoH5UbqtJD56BM15evfkd93fA4OOgBzy6CeS5m9klX-85gUFS8L8Wm9yyB6G-SUTw3KYy7gVNTRZ1TArL4o8VF237m-JkOpki4mhS5j9mNIJVRkHijLFVRk9HUILYHZxqza3OSvHrv9B8pisIy7VYRS4GOjtLkU42_o6DMXGU5-oEV72pi5gIiVXFL4oy8iJiY1p7-TocarI75oehjAciVxGhgkzSwp1u8dlej8f7HasJL-29VkJBm8umAs0l6CozwcgcqoYW90zhPVVkF3jwi16M9S4NpMAlQt9o0y00wU7FF5sXaa_WcMV1poC4genUHe9EkBwG3jRp2dcgbPXvJC4_E8fwkXOL4hSNDhf3MyqIMRDXQ8Tuu1YDbGesi4G2mpwixkIaHe-1lncgFfQyYhbDYaWLA1ALIxHZ2LVik-k9P0GEcEhu_sNkU8V4DBep2H5nhUB7mZgJkNEsq1JSD5zY6ysOWQENXWKZ2puYm0Lv1pv4o_NDr14sm4x5ctawbRIM7UM2cEioVDA5BcUMB-oWutJWRXjI8dAVayyS5beWh1IccafSYZXwPLmbSsZzodLgOgacpmJqcnKvLAlyym7FlO7X-3entq9NsBumpFceK0LoR83GrIce0rVsgrrAXLd5gyGngM3QYBo_mlNVmeo07WilS9-NtddO9SMzTfwOZ4gKK0JSit3f9CVKgw6qzDokTrvrnnNH5FrV0cAPUMTmu1z_kRzIKArv6TwBwxye_bQ2yfmU2t3Vxabr-UmIdM_1OGeogd1UZqgITPQIiRD_I13onF9Xq8u7mNbGJnvmOAE8x6igjfUdAftsk9FezFrwtJUsce5NaIrLYIQWyrum_5HI7e4ilwcc7SpCmCVXErNBRYAjlinACnwrq34Wlq0_6gzs_vZkGn8nv9n6LJGJtXZHVWxcf0QR4q4qiKDR3a2Cc5IdXAvjjoXGZCALaB8EC5Kecx6HOY73ZgUgzbNw2_y8HEpDmbSBHNL0xsx5rAqyuP-WTKSrterbQQsRoPu61uIJQTVJ7JXtQvTvqOBCGof-t1ElEN6Hf3g3xv7HcrS_ei0kfaITt2jixfuIbebfwDlvpi2P9OtxvQHrLZ9TtroVU" alt="Playpex screenshot">
</a>

> Watch this Youtube video for [Playpex App Promo](https://www.youtube.com/watch?v=mj4EjDdVXTo)

## How it works under the hood

Playpex uses a local server initiated by the electron runtime on application bootstrap to take care of streaming torrents
>Disclaimer :
    This app is done for educational purposes and not intended for commercial use as it is illegal to stream pirated movies and shows

### How streaming works ?

The Streaming part works using **media source extentions (MSE)** and :

1. Appending a request listeners on the server for byte range requests
2. Sending an event to the torrent streamer to prioritize that byte range 
3. Set the response headers and wait for data
4. Pump the stream of downloaded data to the client that way you download the content from the Torrent Streamer and pump the downloaded content back to the client at the same time

### The server part

You can check the [playpex server repo](https://github.com/IhebBelhadj/Playpex-backend) if you are intrested in the server implementation of playpex which provides a **Ready to use API for streaming torrents**

### The client side

The client side is built with **angular v14**

The inerface works with spacial navigation(Navigation with keyboad) to simulate the TV app experience and in the next update i'm working on adding a remote app to download on your phone

## State management solution

Playpex uses services and behavior subjects to manage state including 
* focused element
* fetched movies for each categorie
* last selected movie from each category and more

This ensures a smooth navigation between routes

### How to use Playpex

You can build the app from scratch after cloning the app or download the compressed version ready to use [here](https://mega.nz/file/V80xwTyJ#VrSX1fnlIuXL0ghFYE65Qyi-Y1RqOIt-2Vaf2ysohgE)

## Future updates

* Adding remote controller app for mobile devices (cross platform using ionic )
* Using RXJS for managing state
* Recreating module structure and implementing lazy loading to get a better app performance
* Adding account logging and saving movies to watch later and track watched movies
* Add Tv shows section and account management section
