# YouTube (`plugins/youtube`)

YouTube on the big screen, drawn by the core's `catalog` template:

- **Home**: Trending and category rows (Music, Gaming, Sports, News, Entertainment, Comedy, Science & technology, Film & animation, How-to, Education: the ones with a chart in the chosen region), and with a linked Google account first *From your subscriptions*, *Your subscriptions* (channels), *Liked videos*, *Your playlists*. The toolbar's search finds videos, channels and playlists; a **YouTube** chip on the search page does the same.
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
