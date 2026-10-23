### GET /v1/missions/:id/report

Returns the mission report as JSON: live while the mission runs, the final snapshot once it ends (`final: true`).

- `?format=md` returns the report as Markdown.
- `404` when the mission does not exist.
