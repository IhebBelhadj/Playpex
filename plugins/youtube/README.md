# YouTube (`plugins/youtube`)

YouTube on the big screen, drawn by the core's `catalog` template:

- **Home**: a **View** button and a **Category** button in the toolbar (each opens its own choice; one press applies it) (All, Music, Gaming, Sports, News, Entertainment, Comedy, Science & technology, Film & animation, How-to, Education) that narrows any view:
  - **For you** (the default): Playpex's own recommendations, per profile. YouTube's personal home feed isn't in its public API (only in YouTube's private app API, which means impersonating YouTube's app: not done here), so it's made from the profile's signals: what it played in Playpex (kept by the plugin, ≤ 200 videos, recent plays weigh more), its liked videos and its subscriptions (a linked account). Rows: *For you* (new uploads of its subscriptions, a search on the last thing it watched, the latest of the channels it watches most, the charts of its categories, taken in turn), *Because you watched “…”*, *More from <channel>*, *New from your subscriptions*, *Popular in <category>*; what it already played or liked is left out. Made at most every 3 h (sooner after a play). With nothing to go on yet: the charts, saying so.
  - **Subscriptions**: the latest from them, the channels (round), a row per channel. **Liked videos**: all of them (paged), then by category. **Your playlists**: the playlists, then a row each. These need a linked account.
  - **Trending**: the region's chart and its categories' charts.
  **Shorts** show where you browse (Subscriptions, channels, Trending, Liked, playlists, search), marked *Short*, and are **never recommended**: For you leaves them out. YouTube's API doesn't mark them, so a video counts as one when its player is vertical and it lasts 3 minutes at most, or lasts a minute at most, or says #shorts; For you reads channels' uploads from their long-videos lists (`UULF…`), the whole uploads when a channel has none.
  The toolbar's search finds videos, channels and playlists; a **YouTube** chip on the search page does the same. *Watch later* isn't available: Google closed it to apps.
- **Channel**: its latest uploads (paged) and its playlists. **Playlist**: its videos (paged).
- **Playing**: Enter on a video plays it as an `embed` source (plugin API 1.3): YouTube's own IFrame player (youtube-nocookie.com) in the server's page `/embed/youtube`, under Playpex's controls (pause, scrub, ±10 s, volume, speed, media keys, the dashboard's remote commands). YouTube chooses the quality and shows its adverts and marks; a video whose owner doesn't allow embedding says so instead of playing. Nothing is saved to the profile (no resume point or history).

## Set up

**For the people watching:** nothing to make. The admin presses **Plugins › YouTube › Accounts › Link** on their profile; they open google.com/device on their phone, type the code and allow "View your YouTube account". Their rows (subscriptions, liked videos, playlists) then come first in the YouTube section.

**The server provides the credentials** (once, by whoever runs it; `lib/plugins/envSecrets.js`), in the repo root's `.env` or the real environment:

```
PLAYPEX_PLUGIN_YOUTUBE_API_KEY=…          # a YouTube Data API v3 key
PLAYPEX_PLUGIN_YOUTUBE_CLIENT_ID=…        # a Google OAuth client, type "TVs and Limited Input devices"
PLAYPEX_PLUGIN_YOUTUBE_CLIENT_SECRET=…
```

Both from one Google Cloud project: the YouTube Data API v3 switched on, an API key restricted to it, a consent screen (external) **published "In production"** (in Testing, Google only lets its test users in and drops links after 7 days; unverified, people see a warning to click through, up to 100 accounts; Google's verification of the `youtube.readonly` scope removes both). The key's quota (10,000 units a day: a search costs 100, a row 1; rows cached 30 min, searches 1 h) is shared by everyone using that server.

On the dashboard (Plugins › YouTube › Settings) the admin can still enter **their own** key and client: those win over the server's. Also there: the **region** of the trending rows, and **kids profiles** (*Off* by default, or *Search only*: SafeSearch strict plus the profile's own rows).

## Security

- The API key and the account tokens are the server's: encrypted in `playpex.db` (`lib/secretBox.js`), never sent to a client. The key goes to Google as a header (`X-Goog-Api-Key`), never in a URL.
- The account link asks for read-only access only (`https://www.googleapis.com/auth/youtube.readonly`); unlinking revokes the tokens at Google (`revokeUrl`).
- Linking happens only on the dashboard (the admin); each profile links its own account.
- The player's frame holds YouTube's code: Playpex TV's shell sends its device token only from the app's own top frame, so that code can't call the server as the device.

## Tests

`apps/server/test/plugins.youtube.test.js` (a made-up YouTube API: every answer against the template schemas; the embed page; secrets at rest) and the TV scenario `apps/tv/scripts/scenarios/youtube.js` (a real YouTube video through the player's controls: needs the internet).
