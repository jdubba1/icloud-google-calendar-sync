# Security

This tool holds two credentials: a Google OAuth refresh token with calendar
scope and an iCloud app-specific password. It sends them only to
`oauth2.googleapis.com`, `apidata.googleusercontent.com`, and
`*.icloud.com`, and never logs them.

Do not post credentials or private calendar data in public issues.
