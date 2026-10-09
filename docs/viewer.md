# Viewer and REST API

The viewer is a small web page for people. Claude does the designing through MCP; the viewer is for
looking at the results, managing projects and downloading exports. It has no drawing tools.

## Start it

| How | Command | URL |
| --- | --- | --- |
| Alongside Claude Desktop / Claude Code | add `--viewer` to the `mcp` command (see README) | <http://127.0.0.1:7420> |
| Standalone server | `npm start` (= `pixelclaus serve`) | <http://127.0.0.1:7420> |
| Viewer development | `npm run dev` + `npm run dev:viewer` | <http://localhost:5173> (proxies `/api`) |

The viewer and the MCP server read the same data directory (`PIXELCLAUS_DATA`, default `~/.pixelclaus`),
so you can watch Claude work. The project grid and the open project check for a new revision every 3 s
and update by themselves.

## Projects page

- A grid of project cards: thumbnail, name, size, colour mode, frame and layer counts, tags, last
  modified. Newest first.
- A filter box that matches names and ids.
- **Delete** on each card asks for confirmation, then removes the project folder with its checkpoints
  and exports.

## Project page

- **Player.** A pixel-perfect canvas player for the animation:
  - play/pause and step one frame back or forward;
  - pick a tag (forward, reverse and ping-pong are honoured);
  - zoom to Fit, 1×, 2×, 4×, 8× or 16×;
  - backdrop: checker, dark or light.
- **Frame strip.** Every frame with its duration and coloured tag bars. Click a frame to jump to it.
- **Layers.** Listed top to bottom, with groups, per-layer thumbnails, and badges for opacity, blend
  mode, hidden, locked, reference and linked cels. The eye toggle hides a layer **in the preview only**
  and never changes the project.
- **Details.** Size, colour mode, frame count and total duration, tags, slices, checkpoints and
  palette swatches with indices.
- **Export.** A dialog for every format, with options that change per format (scale, frame/tag,
  sprite-sheet layout and JSON, quality, palette format…). The file downloads straight away; several
  files arrive as a zip. The dialog also lists the files Claude exported into the project's `exports/`
  folder, each with a download link.
- **Delete.** Asks for confirmation.

## REST API

All endpoints are JSON unless they return images. Errors look like `{error, hint?, code?}`, with 400 for
invalid input and 404 for anything missing. Error bodies never contain server paths.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | `{ok, name, dataDir}` |
| GET | `/api/formats` | export formats and view modes |
| GET | `/api/projects` | project listings (id, name, size, colour mode, frames, layers, tags, revision, dates) |
| GET | `/api/projects/:id` | full summary: layers, frames, tags, slices, palette colours, checkpoints, revision |
| DELETE | `/api/projects/:id` | delete the project |
| GET | `/api/projects/:id/thumbnail.png` | thumbnail of frame 0 |
| GET | `/api/projects/:id/frames/:n.png` | frame render; `?scale=1..32`, `layers=L1,L2` (isolate), `bg=%23rrggbb`, `hidden=1` |
| GET | `/api/projects/:id/view.png` | an annotated preview (the same views Claude sees); `?view=`, `frame=`, `tag=` |
| POST | `/api/projects/:id/export` | body = export request (see [formats.md](formats.md)); returns the file, or a zip when there are several. `outputDir` is ignored |
| GET | `/api/projects/:id/exports` | files in the project's `exports/` folder |
| GET | `/api/projects/:id/exports/:file` | download one of them |

The MCP endpoint is on the same port: `POST/GET/DELETE /mcp` (Streamable HTTP, session header
`mcp-session-id`).

## Security notes

- The server binds to `127.0.0.1` by default. Host-header validation guards against DNS rebinding.
- `serve` only reads and writes import/export paths inside the data directory. Paths are compared by
  real path, so symlinks do not get around this.
- Exports can never be written into another project's folder.
