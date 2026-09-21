# icloud-google-calendar-sync

Two-way iCloud and Google Calendar sync. Creates and edits sync both ways;
automatic deletion is off by default.

## Why

Keep Google and iCloud calendars in sync, including shared calendars and events
created by agents. Google can serve as the automation layer while Apple Calendar
stays the interface for people.

In Apple Calendar, uncheck the mirrored Google calendars to hide duplicate views.

## How it works

Every event on either side is an **original** or a **mirror**. A mirror is a
copy of the original's VCALENDAR with three changes:

- the UID is rewritten (`<uid>-mirror-<side>`), so a re-run never makes a
  second copy
- every `ATTENDEE` and `ORGANIZER` is stripped, so a mirror can never turn into
  an invitation (iCloud will happily loop you into accepting your own event)
- two markers are added inside the event: `X-SYNC-SOURCE:<side>:<uid>` and
  `X-SYNC-FP:<fingerprint of the original when copied>`

No database or mapping table is required.
Each run lists both calendars over CalDAV for a time window and decides, per
original:

| situation                          | action                             |
| ---------------------------------- | ---------------------------------- |
| no mirror yet                      | create one                         |
| original changed, mirror untouched | refresh the mirror                 |
| mirror edited by a human           | push the edit back to the original |
| both changed                       | later `LAST-MODIFIED` wins         |
| mirror's original is gone          | keep the mirror                    |
| original's mirror is gone          | recreate the mirror                |

"Changed" is a fingerprint of what a human would notice (title, times, location,
notes, recurrence), normalized so that a server rewriting `DTSTAMP`, `SEQUENCE`,
`VTIMEZONE`, or padding an event with empty `DESCRIPTION:` (Google does this)
does not count as an edit. Times are compared as instants, so
`DTSTART;TZID=America/Chicago:…` and the same moment in UTC are equal.

**Automatic deletion is off by default.** Creates and edits still sync both ways.
Deleting an original leaves its mirror intact; deleting a mirror recreates it
on the next run while the original exists. To remove an event completely,
pause your scheduler, remove both copies, then resume it.

Set `"propagateDeletes": true` on a pair to opt into deletions in both directions.
In this mode, originals are stamped `X-SYNC-MIRRORED:<side>` after mirror creation.
A missing mirror deletes its stamped original; a missing original deletes its
mirror. Both require an exact UID lookup across all dates to confirm absence.
Omitting the option or setting `"propagateDeletes": false` disables both kinds
of deletion, including for events stamped by an earlier version.

**Upgrading from 0.2.x:** deletion is no longer automatic. Keep the option unset
for the new behavior, or explicitly set it to `true` to retain deletion propagation.

## Setup

1. **Google.** In [console.cloud.google.com](https://console.cloud.google.com)
   create a project, enable the **Google Calendar API** and the **CalDAV API**,
   and create an OAuth client of type **Desktop**. Then:

   ```
   npx icloud-google-calendar-sync auth google --client-id … --client-secret …
   ```

   Approve in the browser. It prints a refresh token.

2. **iCloud.** At [account.apple.com](https://account.apple.com) → Sign-In &
   Security → App-Specific Passwords, make one. Your username is your Apple ID's
   primary email.

3. **Find your calendars.**

   ```
   ICLOUD_USERNAME=… ICLOUD_APP_PASSWORD=… npx icloud-google-calendar-sync discover icloud
   GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… GOOGLE_OAUTH_REFRESH_TOKEN=… npx icloud-google-calendar-sync discover google
   ```

4. **Write `mirror.config.json`** (see `mirror.config.example.json`). Use `"env:NAME"`
   for credentials and keep personal calendar IDs and URLs out of git.

5. **Dry run, then run.**

   ```
   npx icloud-google-calendar-sync sync --dry
   npx icloud-google-calendar-sync sync
   ```

6. **Cron it.** Every 5 minutes is plenty. Any cron works; the CLI exits
   non-zero on errors.

## As an HTTP handler

```ts
// app/api/calendar/sync/route.ts (Next.js), or any Fetch-API runtime
import { createHandler, loadConfig } from "icloud-google-calendar-sync";

export const GET = createHandler({
  config: loadConfig(null), // from env
  secret: process.env.CRON_SECRET!,
});
```

`GET /?dry=1` plans without writing. `GET /?pair=name` limits to one pair. Auth
is `Authorization: Bearer <secret>` or `x-api-key: <secret>`. Point
[cron-job.org](https://cron-job.org) (free) or anything else at it.

GitHub Actions schedules are not a good cron for this: on low-traffic repos
they fire hours late.

For custom authentication, pass `authorize(req)` instead of `secret`. Return
`true` to allow syncing, `false` to return 401, or a `Response` to return it
unchanged. Async hooks are supported. If both options are supplied, the hook
takes precedence.

A failed sync action stops that pair for the current run. Remaining actions
are reported as skipped and retried from fresh calendar state on the next run.
With deletion propagation enabled, the exception is the `X-SYNC-MIRRORED` stamp:
some originals reject writes, including Gmail-generated events and invitations
you don't organize.
A failed stamp is reported under `warnings`, the run is still `ok`, and the
pair carries on. That event still mirrors both ways; deleting its mirror just
brings the mirror back instead of deleting the original.

## Pairs

A pair is two calendars mirrored into each other. Typical setup:

```json
"pairs": [
  { "name": "personal", "a": "google:you@gmail.com",                       "b": "icloud:<your main iCloud calendar>" },
  { "name": "shared",   "a": "google:<a calendar you made for agents>",  "b": "icloud:<a calendar shared with your partner>" }
]
```

`google:<calendarId>` is a Google calendar id (the email for the primary).
`icloud:<url>` is a CalDAV collection URL from `discover icloud`. Shared iCloud
calendars work as long as you have write access.

## Notes

- **Never mirror attendees.** An event on a shared iCloud calendar with the
  owner as an invitee becomes an invitation to yourself, and every device will
  ask you to accept it forever.
- **Google pads stored events** with `DESCRIPTION:`, `LOCATION:`,
  `STATUS:CONFIRMED`, `TRANSP:OPAQUE`. If your change detection is naive, every
  Google-side mirror looks edited on the next run and ping-pongs.
- **Google CalDAV needs the CalDAV API enabled** separately from the Calendar
  API, in the same Cloud project.

## Development

```
pnpm install
pnpm verify   # typecheck, tests, prettier, build
```

MIT.
