# Mobile API E2E execution notes

Demo CCTV fixture:

- Customer: existing non-production fixture `Budi Santoso Wijaya`
- Camera: `Kamera Gudang A` (`f1b3bc5e-4276-4642-b360-482ecec87db8`)
- Stream: `https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8`
- Recording: disabled (`recording_status=not_recording`)
- Second camera: offline, no stream URL

E2E execution stopped after negative/public cases because the running PM2 environment lacks `JWT_CUSTOMER_ACCESS_SECRET`. Authenticated positive cases cannot be claimed until that environment variable is set and PM2 is restarted with `--update-env`.

Executed:

- T02 PASS: HTTP 400 `VALIDATION_ERROR`
- T05 PASS: HTTP 401 `INVALID_CREDENTIALS`
- T06 PASS: HTTP 401 `INVALID_CREDENTIALS`
- T09 PASS: HTTP 401 `INVALID_CREDENTIALS`
- T10 PASS: HTTP 401 `TOKEN_EXPIRED`
- T14 PASS: HTTP 400 `VALIDATION_ERROR`
- T15 PASS: HTTP 200 generic response
- T17 PASS: HTTP 422 `VERIFICATION_EXPIRED`
- T20 PASS: HTTP 401 `INVALID_CREDENTIALS`
- T28 PASS: HTTP 200 envelope/request ID

Blocked:

- T01/T03/T04/T07/T08/T11/T12/T13: JWT customer access secret missing.
- T16/T18: Mailtrap credential/code verification not available.
- Other authenticated cases: no safe authenticated fixture token.
