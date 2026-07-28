# Security

Please do not publish a suspected vulnerability in an issue. Send a private
report to `lim@limsumin.com` with the affected version, impact, and a minimal
reproduction.

Security-sensitive areas include Redis key isolation, script-response
validation, codec handling, corrupt-state behavior, and operation ID reuse.
Reports about Redis server or client vulnerabilities should also be sent to
their respective maintainers.

Supported releases receive fixes on the latest published minor line. No
response deadline or embargo duration is guaranteed, but verified reports will
be assessed before public disclosure.
