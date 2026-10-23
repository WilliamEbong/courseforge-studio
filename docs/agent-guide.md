# Agent guide: building courses with CourseForge Studio

CourseForge Studio is built so an AI agent (Claude Code, Codex, any MCP client) can do everything a human does in the editor. Every edit is a **command** from one registry. The editor sends the same commands you do.

## 1. Pick an interface
| You are... | Use |
|---|---|
| A coding agent with a shell | `cf` CLI: `node packages/cli/cf.js ...` (or `npm run cf -- ...`) |
| An MCP client | `cf mcp` (stdio). Tools: `list_commands`, `describe_course`, `get_course`, `query`, `run_commands`, `validate`, `new_course`, `undo`, `redo`, `play`, `publish`, `import_story` |
| A computer-use agent | The editor (`cf serve`). Every control has an accessible name and `data-cmd="<command>"`; press `?` there for the keyboard shortcuts |
| A script or tool that speaks HTTP | The local HTTP API of `cf serve` (section 6) |

### Register the MCP server
Claude Code:
```bash
claude mcp add courseforge-studio -- node "<abs>/courseforge-studio/packages/mcp/server.js" --root "<abs>/courseforge-studio/courses"
```
Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.courseforge-studio]
command = "node"
args = ["<abs>/courseforge-studio/packages/mcp/server.js", "--root", "<abs>/courseforge-studio/courses"]
```
On Windows, use forward slashes in TOML paths. File arguments are relative to `--root`. Paths outside it are rejected.

## 2. The loop that works
1. `cf describe <file>`: a compact outline, one line per slide, object, layer and trigger. Read it before editing.
2. `cf commands` and `cf commands <name>` show the exact args (JSON Schema) plus examples. `docs/commands.md` has everything.
3. Edit with `cf cmd <file> '<json array of {cmd,args}>'`. Batches are **atomic**: if one command fails, nothing is saved.
4. Errors look like `{path, code, message, hint}`. The `hint` lists valid alternatives (existing IDs, allowed values). Fix the call and retry.
5. Verify behavior headless: `cf play <file> events.jsonl` or `cf test <file> scenario.json`.
6. `cf validate <file>`, then `cf publish <file> --web|--scorm12 <outDir> [--zip]`.

For a Moodle/SCORM upload ZIP through MCP, call `publish {"file":"demo.story","target":"scorm12","out":"dist/demo-scorm12","zip":true}`. The optional `zip` flag is a boolean, defaults to false and is supported only for `scorm12`. The response includes `result.zip` pointing to `<out>.zip`, alongside the published folder. Upload that ZIP as a SCORM activity; a package check or mock-LMS run does not verify a particular Moodle installation.

Pass your own readable IDs (`s-intro`, `o-start`, `l-help`, `t-next`) so later commands can refer to them. When you omit an ID, one is generated and returned in `results`.

### Native files

Use `cf new demo.story --title "Demo"` or MCP `new_course {"file":"demo.story","title":"Demo"}` for a native slide course. Pass the same `.story` path to describe, commands, queries, validation, undo/redo, play and publish. New native courses contain an initial slide; inspect the returned document before adding your own. Lessons use `.course.json`.

Native saves preserve archive content outside supported edits and verify the saved model before replacing the file. Unsupported operations return `story-unsupported`; inherited or referenced content can return `story-inherited` or `story-referenced`. A locked destination returns `story-locked`. Read the error hint and choose a supported edit; do not retry by converting or overwriting the original. To replace an image, add a new asset and change the object's image reference rather than changing an existing asset's path.

Native undo/redo stores exact archives in `<file>.history/`, with up to 101 snapshots for 100 steps. It refuses history after an external edit or a missing/corrupt snapshot. Representative generated-course native open, preview, save and reopen checks pass; standalone publishing from Storyline remains unverified. Native support is experimental. After an external Storyline save, refresh describe/get_course: Storyline can replace CF ID aliases with IDs derived from native GUIDs.

## 3. Recipes
**Slide with a button that jumps:**
```json
[{"cmd":"slide.add","args":{"id":"s-intro","title":"Welcome","objects":[{"id":"o-start","type":"button","text":"Start","x":80,"y":520,"w":240,"h":64}]}},
 {"cmd":"slide.add","args":{"id":"s-next","title":"Next"}},
 {"cmd":"trigger.add","args":{"slide":"s-intro","on":{"event":"click","target":"o-start"},"do":[{"action":"jump","to":"s-next"}]}}]
```
**Popup layer (modal) with a close button:**
```json
[{"cmd":"layer.add","args":{"slide":"s-intro","id":"l-help","title":"Help","modal":true,"hideOthers":false,"objects":[{"id":"o-close","type":"button","text":"Close"}]}},
 {"cmd":"trigger.add","args":{"slide":"s-intro","layer":"l-help","on":{"event":"click","target":"o-close"},"do":[{"action":"hideLayer"}]}}]
```
**Variable + condition + else:**
```json
[{"cmd":"var.add","args":{"name":"score","type":"number"}},
 {"cmd":"trigger.add","args":{"slide":"s-intro","on":{"event":"click","target":"o-start"},"if":{"all":[{"var":"score","op":">=","value":80}]},"do":[{"action":"jump","to":"s-next"}],"else":[{"action":"showLayer","layer":"l-help"}]}}]
```
**Copy objects to another slide or layer** (fresh ids; the triggers they fire come along, pointing at the copies):
```json
[{"cmd":"object.duplicate","args":{"ids":["o-start","o-card"],"slide":"s-next","layer":"l-help"}}]
```
The result is `{ids, triggers, skipped}`: new object ids in `ids` order, new trigger ids, and the source triggers that were not copied because they use objects or layers the destination slide lacks. Omit `slide` and `layer` to duplicate in place; `dx`/`dy` offset the copies; `newIds` chooses their ids.

**Align, distribute, move several objects:**
```json
[{"cmd":"object.align","args":{"ids":["o-a","o-b","o-c"],"edge":"top"}},
 {"cmd":"object.distribute","args":{"ids":["o-a","o-b","o-c"],"axis":"horizontal"}},
 {"cmd":"object.align","args":{"ids":["o-title"],"edge":"center"}},
 {"cmd":"object.set","args":{"id":"o-a","y":40}},{"cmd":"object.set","args":{"id":"o-b","y":40}}]
```
Several ids align to their bounding box; one id aligns to the slide (or pass `"to":"slide"`). Distribute needs 3+ objects. A batch of `object.set` is one undo step, like a group drag in the editor.

**Timing:** `object.set {id, start, end}` in ms (`"end": null` = until the end of the slide or layer); `slide.set` / `layer.set {id, duration}`.

**Reorder layers and clear optional fields** (`null` removes a field or one style key):
```json
[{"cmd":"layer.move","args":{"id":"l-help","index":0}},
 {"cmd":"slide.set","args":{"id":"s-intro","background":null}},
 {"cmd":"state.set","args":{"target":"o-start","state":"hover","style":{"fill":null}}},
 {"cmd":"object.set","args":{"id":"o-start","style":{"bold":null}}},
 {"cmd":"trigger.set","args":{"id":"t-next","name":null}}]
```

**Slider and dial** (each binds a number variable, which is also its starting value)
```json
[{"cmd":"var.add","args":{"name":"level","type":"number","initial":0}},
 {"cmd":"object.add","args":{"slide":"s-intro","id":"o-level","type":"slider","var":"level","min":0,"max":10,"step":1,"name":"Level","x":80,"y":300,"w":600,"h":48}},
 {"cmd":"object.add","args":{"slide":"s-intro","id":"o-knob","type":"dial","var":"level","max":10,"startAngle":-135,"endAngle":135,"x":800,"y":240,"w":200,"h":200}},
 {"cmd":"object.add","args":{"slide":"s-intro","type":"text","text":"Level: %level%"}},
 {"cmd":"trigger.add","args":{"slide":"s-intro","on":{"event":"varChange","var":"level"},"if":{"all":[{"var":"level","op":">=","value":8}]},"do":[{"action":"showLayer","layer":"l-help"}]}}]
```
Defaults: `min` 0, `max` 10 (dial 12), `step` 1, `live` true (`false` = update on release), dial angles -90..90 (degrees clockwise from 12 o'clock). Values snap to `min + n*step` and are clamped. Headless: `{"type":"slide","target":"o-level","value":7}`. Learners use the mouse or the keys (arrows ±step, Home/End, PageUp/PageDown).

**Hotspot question** (the picture is an ordinary image object; areas are in slide coordinates; the first area containing the click decides):
```json
[{"cmd":"slide.add","args":{"id":"s-hs","title":"Find the valve","objects":[{"id":"o-pic","type":"image","image":"a-plant","x":0,"y":80,"w":1280,"h":640,"alt":"Pipework"}]}},
 {"cmd":"question.set","args":{"slide":"s-hs","type":"hotspot","prompt":"Click the shut-off valve","areas":[{"id":"valve","shape":"ellipse","x":820,"y":300,"w":160,"h":120,"correct":true},{"id":"pump","x":200,"y":260,"w":240,"h":200}]}}]
```
Headless: `{"type":"point","x":900,"y":360}` then `{"type":"submit"}`. In a quiz, the LMS gets SCORM 1.2 `choice`: area 1 = `a`, area 2 = `b`, …, a click outside every area = the next letter; one correct pattern per correct area.

**Video or audio with captions** (files are published as they are; captions are WebVTT and start hidden; learners use the CC button or Ctrl+Alt+C):
```json
[{"cmd":"asset.add","args":{"id":"a-clip","path":"assets/clip.mp4","alt":"Demonstration"}},
 {"cmd":"asset.add","args":{"id":"a-cc","path":"assets/clip.vtt"}},
 {"cmd":"object.add","args":{"slide":"s-intro","id":"o-vid","type":"video","media":"a-clip","captions":"a-cc","autoplay":true,"controls":false,"x":160,"y":60,"w":960,"h":540}},
 {"cmd":"trigger.add","args":{"slide":"s-intro","on":{"event":"mediaEnd","target":"o-vid"},"do":[{"action":"showLayer","layer":"l-help"}]}},
 {"cmd":"trigger.add","args":{"slide":"s-intro","on":{"event":"click","target":"o-start"},"do":[{"action":"playMedia","target":"o-vid"}]}}]
```
Actions `playMedia`, `pauseMedia`, `stopMedia` (pause and rewind). Without `controls` a click on the video plays or pauses it. When the first slide autoplays media, the player shows a Start button first (browser autoplay policy). Headless runs record `media play o-vid` lines in the trace; report the end with `{"type":"mediaEnd","target":"o-vid"}`.

**Freeform drag-and-drop question** (items and targets are base-layer objects of the slide; an item without `target` is a distractor):
```json
[{"cmd":"question.set","args":{"slide":"s-sort","type":"dragdrop","prompt":"Sort the waste","items":[{"object":"o-glass","target":"o-sharps"},{"object":"o-gloves","target":"o-bag"},{"object":"o-paper"}],"targets":[{"object":"o-sharps"},{"object":"o-bag","capacity":"many"}]}}]
```
A drop outside every target returns the item to its start; a `one` target (default) centres its item and a new drop sends the old one home; a `many` target stacks items from its top-left. Correct only when every item is on its target and distractors are on none. Headless: `{"type":"drop","item":"o-glass","target":"o-sharps"}` (`"target":null` puts it back). Learners drag with the mouse, or press Enter/Space on an item and then on a target. In a quiz, the LMS gets SCORM 1.2 `matching`, for example `0.a,1.b` (item digit, target letter; at most 10 items and 26 targets).

**Matching (a drop-down per row) and sequence (put in order):**
```json
[{"cmd":"slide.add","args":{"id":"s-match","title":"Signs","question":{"type":"matching","prompt":"Match each sample to its sign","choices":[{"id":"bio","label":"Biohazard"},{"id":"rad","label":"Radiation"}],"rows":[{"id":"blood","label":"Blood","choice":"bio"},{"id":"urine","label":"Urine","choice":"bio"},{"id":"iso","label":"Isotope","choice":"rad"}]}}},
 {"cmd":"slide.add","args":{"id":"s-order","title":"Steps","question":{"type":"sequence","prompt":"Put the steps in order","choices":[{"id":"wash","label":"Wash hands"},{"id":"gloves","label":"Put on gloves"},{"id":"work","label":"Start work"}]}}}]
```
Matching: every row lists every choice (rows may share one); Submit needs every row. Sequence: `choices` are listed in the correct order and shown shuffled; learners drag rows (insertion) or use Move up/down. Headless: `{"type":"match","row":"iso","choice":"rad"}` and `{"type":"order","choice":"wash","index":0}`. In a quiz the LMS gets SCORM 1.2 `matching` (`0.a,1.a,2.b`: row digit, choice letter; at most 10 rows) and `sequencing` (`a,b,c`).

**Marker** (a round button; its label opens on click or keyboard focus and closes on Escape, blur or a click elsewhere):
```json
[{"cmd":"object.add","args":{"slide":"s-intro","type":"marker","text":"Fume hood","detail":"Keep the sash below the marked line.","x":600,"y":300,"w":48,"h":48}}]
```

**Reusable slides** (copy an interaction into another course; same as Export / Insert from file in the editor):
```bash
cf query a.course.json slide.export '{"id":"s-card"}' > card.slide.json   # {kind:"cf.slide/1", slide, variables, assets}
cf cmd b.course.json "{\"cmd\":\"slide.import\",\"args\":{\"data\":$(cat card.slide.json)}}"
```
Fresh ids everywhere; missing variables and assets are added; triggers that point at slides or quizzes the target lacks are skipped and listed in `result.skipped`.

**Entrance and exit effects**: the entrance plays from the object's `start`; the exit ends at its `end` (it needs one). Effects are `fade | fly | grow | zoom`, `duration` in seconds (default 0.75), `direction` for fly (`b bl l tl t tr r br`, default `b`). Visibility and triggers do not change; reduced-motion users see no movement. `null` removes an effect
```json
[{"cmd":"object.set","args":{"id":"o-title","start":1000,"end":4000,"enter":{"effect":"fade","duration":0.5},"exit":{"effect":"fly","direction":"r","duration":0.25}}}]
```

**Theme preset and font** (both modes)
```json
[{"cmd":"theme.apply","args":{"preset":"charcoal","font":"serif"}}]
```
`player.set {"style":"modern"}` selects Modern for native `.story` export and CF presentation; `"classic"` selects Classic. The same setting is available under Course → Player style. Native style-only edits preserve opaque player settings. CF's modern presentation is its own responsive player, not full native theme/control parity.

`cf query <file> theme.list` returns the presets (`auto`, `light`, `charcoal`, `ocean`, `forest`, `high-contrast`) with their tokens, the fonts (`system`, `serif`, `rounded`, `mono`: system font stacks, nothing is downloaded) and the current `{preset, font}`. A preset writes the full token set of both players into `player.theme` (chrome plus the slide stage, which stays light) and replaces the previous preset; other tokens set with `player.set {theme}` stay. Presets are explicit schemes: `charcoal` stays dark on a light device and `light` stays light on a dark one; `{"preset":"auto"}` removes the preset so the player uses its style default (Modern: charcoal) or the device setting. Every preset meets WCAG AA contrast on its text pairs. Pass `font` alone to change only the typeface.

**Images from the built-in library** (original SVG illustrations and icons drawn for CourseForge Studio)
```bash
cf query <file> library.list '{"tag":"ppe"}'   # [{id, file, title, tags, alt}]; {"q":"flask"} searches id, title, tags and alt
```
```json
[{"cmd":"asset.add","args":{"id":"a-goggles","library":"goggles"}},
 {"cmd":"object.add","args":{"slide":"s-intro","type":"image","image":"a-goggles","alt":"Safety goggles with clear lenses and a strap","x":900,"y":200,"w":240,"h":240}}]
```
The asset gets `path: "library/<file>"` and the library's alt text (pass `alt` to override). Nothing is downloaded: the editor and the publisher read `packages/library/`, and the publisher copies the file into the package; a file with the same name in the course folder wins. In lessons mode use the asset in `block.add {"type":"image","image":"a-goggles"}`, a gallery item or the cover. An unknown id fails with the list of valid ids.

**Check before publishing:** `cf query <file> a11y` and `cf query <file> validate` (the editor's Check button shows the same list; each issue names the command that fixes it).

**Question bank and draw** (bank slides are ordinary slides kept outside the flow, so every slide, object, trigger and question command works on them)
```json
[{"cmd":"bank.add","args":{"id":"bk-ppe","title":"PPE questions"}},
 {"cmd":"slide.add","args":{"id":"s-b1","bank":"bk-ppe","title":"Goggles","question":{"type":"tf","prompt":"Goggles protect your eyes","choices":[{"id":"t","label":"True","correct":true},{"id":"f","label":"False"}]}}},
 {"cmd":"slide.add","args":{"id":"s-b2","bank":"bk-ppe","title":"Gloves","question":{"type":"mc","prompt":"Which gloves for solvents?","choices":[{"id":"a","label":"Nitrile","correct":true},{"id":"b","label":"Cotton"}]}}},
 {"cmd":"draw.add","args":{"id":"s-draw","bank":"bk-ppe","count":1,"title":"PPE check"}},
 {"cmd":"quiz.add","args":{"id":"qz","questions":["s-draw"]}}]
```
On entering `s-draw` the player picks `count` bank slides (0 = all; `shuffle` false keeps bank order; `always`/`never` list bank slides), shows them in place of the draw and scores only those. `resetQuiz` draws again. A quiz lists the draw slide, never a bank slide. Move a slide in or out with `slide.move {"id":"s-b2","bank":"bk-ppe"}` / `{"id":"s-b2","scene":"sc-1"}`; change a draw with `draw.set`. `cf describe` lists banks after the scenes and each draw as one line. Headless runs log `draw s-draw s-b2` in the trace; the snapshot keeps the drawn set.

**Quiz with results:** see `samples/lab-safety.cmds.jsonl` (questions `mc|mr|tf|fill`, `quiz.add`, a results slide whose `timelineStart` runs `submitQuiz`, then a pass/fail layer chosen from `<quiz>.passed`, `resetQuiz` for retry, and `tracking.set`). `quiz.addResults` also adds a **Review quiz** button (`review: false` leaves it out; `quiz.set {"id":"qz","review":true|false}` adds or removes it later). Its `reviewQuiz {quiz}` action steps through the submitted attempt read-only (answers and correct answers in `view.question.review`), and Next after the last question returns to the results slide; review never changes the score, status or interactions.

## 4. Runtime rules you can rely on
- One event runs its triggers top to bottom, synchronously.
- `setVar` fires that variable's `varChange` triggers **immediately**, but only if the value actually changed.
- `jump` ends the rest of the action list.
- `showLayer` runs the layer's `timelineStart` triggers before continuing.
- Revisits: `reset` returns to the initial state. `resume` restores layers and states. `auto` behaves as resume when the slide has interactive objects.
- Disabled or hidden objects ignore clicks. A visible `modal` layer blocks clicks outside it.
- Quiz score % is truncated to 2 decimals. Pass/fail is reported when `submitQuiz` runs. `resetQuiz` sets incomplete and returns to the first question.

## 5. Scenario files (`cf test`)
```json
{"events":[{"type":"click","target":"o-start"},{"type":"choose","choice":"b"},{"type":"submit"},{"type":"continue"}],
 "expect":{"slide":"s-results","status":"passed","vars":{"score":10},"trace":["enter s-q1"],"traceOrder":["enter s-intro","enter s-q1"],"lms":["status passed"]}}
```
Event types: `click|hoverEnter|hoverLeave {target}`, `key {key}`, `next`, `prev`, `menu {slide}`, `tick {ms}`, `choose {choice}`, `input {target, text}` or `input {answer:true, text}`, `slide {target, value}` (slider/dial), `point {x, y}` (hotspot), `drop {item, target}` (drag and drop), `match {row, choice}` (matching), `order {choice, index}` (sequence), `mediaEnd {target}`, `submit`, `continue`, `review {quiz?}` (review a submitted quiz; default: the quiz of this results slide), `exitReview`.

## 6. Local HTTP API (`cf serve`)
`cf serve [--root courses] [--port 8420]` binds to 127.0.0.1 only and prints `http://127.0.0.1:<port>/?token=<token>`. The token is kept in `<root>/.cf-token` and reused, so an open editor keeps working across restarts (`--new-token` rotates it). Send it as the `x-cf-token` header (or `?token=`) on every `/api/` call. Requests with another `Host` header are refused. Bodies are capped at 5 MB. Errors use the same `{ok:false, errors:[{path, code, message, hint}]}` shape as the CLI and MCP.

| Method and path | Does |
|---|---|
| `GET /api/commands` | every command with its args schema and examples |
| `GET /api/courses` | `{courses:[{name, file, format, title, rev}]}` for root `.story` and `.course.json` files |
| `POST /api/courses` `{name, title?, mode?, format?}` | use `format:"story"` for native slides or `format:"json"` for JSON; Lessons require JSON (409 if the course exists) |
| `GET /api/courses/<name>` | `{doc, rev, history:{undo, redo}, file}` |
| `POST /api/courses/<name>/commands` `{commands:[{cmd,args}], rev?}` | atomic batch, same as `cf cmd`. With `rev`, a stale course returns 409 and nothing is applied |
| `POST /api/courses/<name>/undo`, `/redo` | shared history with the CLI and MCP |
| `GET /api/courses/<name>/query/<query>?args=<url-encoded JSON>` | `course.describe`, `find`, `validate`, `a11y`, ... |
| `POST /api/courses/<name>/publish` `{target:"web"\|"scorm12", zip?:boolean}` | writes `<root>/dist/<name>-<target>/`; `zip:true` for SCORM also writes the adjacent ZIP and returns its path as `zip` |
| `GET /api/courses/<name>/events` | Server-Sent Events: `{rev}` whenever the file changes, whoever changed it |
| `POST /api/import` `{path, name, format?}` | import the `.story` at `path` inside the root; `format:"story"` copies natively, `format:"json"` converts (201; 409 if it exists). Returns `{summary, reportFile, doc, rev, file}` |

The editor UI uses exactly these endpoints. `GET /preview/<name>` plays the course in the learner player.

Each course needs a unique stem: `demo.story` alongside `demo.course.json` returns an ambiguity error. Native load responses also include `importSummary`.

Omitting `format` keeps the HTTP API's existing JSON default. The editor explicitly selects native `.story` by default for slide courses.

## 7. Importing a Storyline project
`cf import <file.story> <out.story> [--assets DIR]` creates a native copy; an `<out.course.json>` destination converts to the mapped CF model. MCP uses `import_story {story, file, assets?}`; HTTP uses `POST /api/import {path, name, format:"story"|"json"}`. The source is only read. Images go to `assets/<name>/` next to the course unless `--assets` names another folder inside the course folder. Changed native image bytes receive a different extracted path so preview and publishing use the correct version. On Windows, EMF media is rasterized to PNG for display and publishing while native saves preserve the original media; other platforms report it as unsupported.

- Mapped: scenes, slides (title, size, duration, advance, revisit, simple background color, notes), text boxes and rectangle/ellipse/rounded shapes (plain text, simple fill), pictures (png, jpg, gif), buttons, built-in states, user variables, layers (modal, hide others, hide on end), triggers (click, player next/prev, timeline start/end, variable change; jump, scene, show/hide layer, set state, adjust variable, submit, links, quiz submit/reset; numeric and variable conditions with else), multiple choice, multiple response, true/false and fill-in questions with their feedback text, freeform drag-and-drop questions (items, keys and one/many targets; unlimited attempts become `attempts: 0`), markers (title and label text), quizzes and results slides, question banks and draw slides (bank, number drawn, shuffle, always/never; a quiz lists the draw). The importer also maps sliders/dials with drag updating, rectangular/oval hotspot questions, and local MP4 video with poster images and VTT captions. Dial angles, oval area mapping and slide-wide hotspot grouping are inferred and reported. Matching dropdowns and both sequence encodings now import with shared feedback, attempts and points; matching drag pairs become dropdown matching rows with a presentation report. Sequence answer order and empty-correctText matching keys are inferred and reported for author review. Rich paragraphs preserve supported mixed-run styles, bullets, numbering, links and master theme colours/fonts; unresolved formatting is reported. Two heuristics (ours) each emit a heuristic.* item: first gradient stop to solid color, and picture name to missing alt only with explicit accessibility inclusion. Lines and arrows become `line`/`arrow` shapes (a stroke along the box centre line, turned by `rotation`, stroke from `style.border`/`borderWidth`); block arrows, folded-corner and one-side-rounded rectangles and many-sided polygons become the nearest shape with a heuristic.* item. A slide without its own background takes its layout's or master's (heuristic.inheritedBackground), and master/layout objects such as logos and footer bars are copied onto each slide behind its content with `locked: true` (the editor will not move them until you clear Locked). Audio, unknown hotspot area tags and unknown control update modes remain reported as unsupported.
- Everything else is listed in `<name>.import-report.json` as `{path, kind, reason}` (path = part and element inside the `.story`). The command output carries a summary: source, mapped and consumed counts plus the report entries by kind. Read the report before editing: it is the to-do list of what must be rebuilt by hand.
- The result always passes `cf validate`; anything that would not was removed and reported with kind `invalid`.

## 8. Lessons mode (Rise-style courses)
A course with `mode: "lessons"` is an outline of **sections → lessons → blocks** that the learner scrolls, instead of slides and triggers. Same file format, same commands loop, same publish targets. Behavior follows the lessons-mode rules in. A full example built only from commands: `samples/lab-basics-lessons.cmds.jsonl` (`.scenario.json`).

**Start:** `cf new <file> --mode lessons --title "Lab Basics"`, or `course.set {"mode":"lessons"}` on any course (that swaps `slidesViewed` and `lessonsViewed` tracking). Then:
```json
[{"cmd":"section.add","args":{"id":"sec-basics","title":"Basics"}},
 {"cmd":"lesson.add","args":{"id":"l-ppe","title":"Protective equipment","blocks":[
   {"type":"text","text":"First paragraph.\n\nA blank line starts the next one."},
   {"id":"b-acc","type":"accordion","items":[{"title":"Goggles","text":"..."},{"title":"Gloves","text":"..."}]},
   {"type":"continue","require":"above"},
   {"type":"tabs","items":[{"title":"Before","text":"..."},{"title":"After","text":"..."}]},
   {"type":"flashcards","items":[{"front":"Splash risk","back":"Goggles"}]},
   {"type":"continue","require":"allAbove","label":"I have explored both"}]}}]
```
Block ids are generated when you omit them (returned in `results[i].blocks`). Every collection is called `items`. `cf commands block.add` lists every block type and its fields; `docs/commands.md` has the same table.

**Blocks:** `heading {text, level 2|3}`, `text`, `list {kind: bullet|numbered|checkbox, items}`, `quote {text, cite}`, `divider`, `image {image, alt, caption}`, `imageText {image, text, side}`, `gallery {columns, items[{image, alt, caption}]}`, `video|audio {media, captions, title}` (captions = a `.vtt` asset), `accordion|tabs {items[{title, text}]}`, `flashcards {items[{front, back}]}`, `labeledGraphic {image, items[{x, y, title, text}]}` (x/y in % of the image), `process {intro, items[{title, text}], summary}`, `timeline {items[{date, title, text}]}`, `button {label, text, url | toLesson}`, `continue {label, require: none|above|allAbove}`, `question` (below), `sorting {categories (1–4), items[{text, category}]}`, `scenario` (below). Any block takes `style {width: narrow|normal|wide|full, padding: none|small|normal|large, align, background, color}`.

**Knowledge check** (ungraded, never sent to the LMS) or quiz question:
```json
{"cmd":"block.add","args":{"lesson":"l-ppe","type":"question","kind":"mc","prompt":"Which item is essential when heating?",
 "choices":[{"id":"a","label":"Goggles","correct":true,"feedback":"Right."},{"id":"b","label":"Sandals","feedback":"Never at the bench."}],
 "attempts":2,"hideCorrect":false}}
```
Kinds: `mc` (one correct, per-choice feedback allowed), `mr` (≥1 correct), `fill {answers, caseSensitive}`, `matching {pairs[{left, right}]}` (2–10 pairs). `feedback {correct, incorrect, any}` covers the other feedback modes.

**Scenario** (branching dialogue): scenes hold `dialogue` items (the character's line and 1–3 responses, each with optional `feedback`) and `text` items (narration with one Continue). Each response or text item has `goTo`: `next` (default: the next item, then the next scene, then the end), `retry` (restart this scene), `end`, or a scene or item id of the same block. Scene and item ids are local to the block; `next`, `retry` and `end` are reserved. Scene titles are for authors only. `block.add {"lesson":"l-x","type":"scenario"}` alone gives a valid one-scene starter.
```json
{"cmd":"block.add","args":{"lesson":"l-spill","id":"b-talk","type":"scenario","ending":"Robin thanks you.","scenes":[
  {"id":"s-spill","title":"The spill","background":"a-bench","backgroundAlt":"","character":"a-robin","characterAlt":"Robin, a lab technician","items":[
    {"id":"i-ask","kind":"dialogue","text":"I knocked over some acid. What first?","responses":[
      {"id":"a","text":"Warn people and step back.","feedback":"Right: people first.","goTo":"i-kit"},
      {"id":"b","text":"Wipe it up with paper towels.","feedback":"Not yet.","goTo":"retry"}]},
    {"id":"i-kit","kind":"text","text":"Robin fetches the spill kit."}]},
  {"id":"s-clean","items":[{"id":"i-clean","kind":"dialogue","text":"What next?","responses":[
    {"id":"a","text":"Gloves, then absorbent pads.","goTo":"end"},{"id":"b","text":"Start again.","goTo":"s-spill"}]}]}]}}
```
Validation refuses unknown `goTo` targets, duplicate or reserved ids, dialogue without responses (or with its own `goTo`), text with responses, and a scenario whose first item can never reach an end. Edit it with `block.set {"id":"b-talk","scenes":[...]}` (the array is replaced). Play it with `respond {block, response}` and `continue {block}`; `retry {block}` starts over after the end. Reaching an end completes the block, so a `continue` gate can require it.

**Quiz lesson** (graded one question at a time; holds only `question` blocks) and tracking:
```json
[{"cmd":"lesson.add","args":{"id":"l-quiz","title":"Final quiz","kind":"quiz","passPercent":75,"attempts":2,"reveal":"incorrect","blocks":[...]}},
 {"cmd":"tracking.set","args":{"complete":[{"quiz":"l-quiz"}],"status":"passed-failed"}}]
```
Defaults: `passPercent` 80, `attempts` 0 (unlimited), `reveal` all (result, feedback and the correct answer after each question; `incorrect` = no correct answer; `none` = nothing until the score), `randomize`/`shuffle` off, `requirePass` off. `{"lessonsViewed": 50}` completes the course as soon as half the lessons are complete.

**Course settings:** `player.set {"navigation":"restricted"}` (lessons in sequence, no search), `theme.apply {"preset":"ocean"}` (or single tokens with `player.set {"theme":{"accent":"#0b5d5d"}}`), `course.set {"cover":{"image":"a-cover","alt":"..."}}`. Reorganize with `section.move|set|remove`, `lesson.move {id, section?, index?}`, `lesson.duplicate`, `block.move {id, lesson?, index?}`, `block.duplicate`, `block.set {id, ...}` (`type` may switch, e.g. accordion ↔ tabs; `null` removes a field). Removing a lesson that buttons or tracking point to needs `force:true`.

**Rules you can rely on** (D = documented in the digest, [ours] = our rule):
- Blocks after the first unpassed `continue` are hidden; `above` needs the block directly above complete, `allAbove` every completable block since the previous continue (D). Completable: accordion, tabs, flashcards, labeled graphic, process (all items opened), video/audio (played to the end), checkbox list (all checked), knowledge check (answered once), sorting (all cards placed), scenario (an end reached) [ours]. The first tab, and the first process step when there is no intro, count as seen.
- A content lesson completes when the learner reaches its end with no gate pending; a quiz lesson when its results show (when passed, if `requirePass`) [ours, after C ].
- Knowledge checks: Take Again only after an incorrect answer while attempts remain (D). Quiz: one point per question, no partial credit, score truncated to 2 decimals; Take Again stays while attempts remain, even after a pass (C).
- LMS: each quiz question sends an interaction (`<lesson>_<block>_<attempt>`; matching as SCORM `matching` pairs), the results send the score, then the status. Resume is automatic and returns to the saved lesson (C).

**Scenario events (`cf test`, `cf play`, MCP `play`):** `start` (the cover), `next`/`prev` (adjacent lesson; from the cover, the first or last-visited one), `open {lesson}` (omit `lesson` for the cover), `end`, `reach {block}`, `item {block, index}`, `continue {block}` (a gate) or `continue` (quiz: start / next question / results), `choose {block?, choice}`, `input {block?, text}`, `match {block?, left, right}`, `submit {block?}` (block optional inside a quiz), `retry {block}` (knowledge check, sorting, or a scenario after its end), `respond {block, response}` (scenario), `retake` (quiz), `sort {block, item, category}`, `search {q}`, `restart`. `expect.lesson` checks the final lesson. Traces read like `enter l-ppe`, `gate b-gate blocked b-acc`, `complete b-acc`, `kc b-kc correct`, `respond b-talk a`, `scenario b-talk i-kit`, `scenario b-talk end`, `quiz l-quiz 75 passed`, `lms status passed`.

The editor has a lessons view over the same commands: outline (sections, lessons), a lesson page of block cards drawn with the player's styles, an Insert menu with every block type, per-block forms, lesson and course settings, Export / Insert from file (`lesson.export` / `lesson.import`). Create a lessons course with `cf new --mode lessons`, MCP `new_course {"file":"x.course.json","mode":"lessons"}` or `POST /api/courses {"name":"x","mode":"lessons"}`. Clearing one style key is `block.set {"id":"b-x","style":{"background":null}}`.

## 9. Rich slide text
Text, shape and button objects accept `rich`, an array of paragraphs. Each paragraph has `runs`, optional `list: "bullet" | "number"`, nesting `level` from 1 to 5 (default 1), and `align: "left" | "center" | "right" | "justify"`. Runs have `text` and optional `b`, `i`, `u`, `s`, `color` (`#rrggbb`), `size` (pixels), `font` (a local font family) and `link` (`https:`, `http:` or `mailto:`).

```json
{"cmd":"object.set","args":{"id":"o-instructions","rich":[
  {"runs":[{"text":"Welcome, "},{"text":"%learner%","b":true,"color":"#245678"}]},
  {"list":"bullet","level":1,"runs":[{"text":"Read the guide","link":"https://example.org/guide","u":true}]},
  {"list":"number","level":1,"runs":[{"text":"Start here","i":true}]}
]}}
```

The registry derives `text` as paragraph text joined with newlines. This keeps search, accessibility names and agent queries working. If both `text` and `rich` are sent, rich supplies the mirror. `object.set {"id":"o-instructions","text":"Plain replacement"}` deliberately removes rich formatting. `rich: null` removes formatting while keeping the current text. Variables substitute inside runs; `var.set {name, newName}` updates those references too. State overrides keep plain `text`: a state with its own text replaces base rich text, while a style-only state preserves it.

The editor Text field uses the same `object.set` command. Select text, use Bold/Italic/Underline (or Ctrl+B/Ctrl+I/Ctrl+U), Bullets, Numbering or Link, then leave the field and toolbar to save one undo step. Tab/Shift+Tab reaches the toolbar buttons, and Enter activates them. Paste inserts plain text. Clear formatting removes the supported formatting from the selection. Preview and web/SCORM output share the canvas renderer, including nested semantic lists and safe links. Fonts are not embedded: choose fonts installed on the learner's computer or allow its normal fallback.

## 10. Export for Storyline

All interfaces use the shared publisher target registry in `packages/core/publish-targets.js`. The editor's **Export for Storyline** dialog offers the same outputs. No course source is changed.

| Output | CLI | MCP publish | HTTP publish body |
|---|---|---|---|
| PowerPoint | `cf publish demo.course.json --pptx deck.pptx` | `{"file":"demo.course.json","target":"pptx","out":"deck.pptx"}` | `{"target":"pptx"}` |
| Excel questions | `cf publish demo.course.json --questions questions.xlsx` | `{"file":"demo.course.json","target":"questions","out":"questions.xlsx"}` | `{"target":"questions"}` |
| Text questions | `cf publish demo.course.json --questions questions.txt` | `{"file":"demo.course.json","target":"questions","out":"questions.txt"}` | `{"target":"questions","format":"txt"}` |

HTTP: `POST /api/courses/demo/publish` with the usual token; files go to `dist/demo-pptx.pptx` or `dist/demo-questions.xlsx|txt`. The response retains `ok,out` and adds `result` for file targets. CLI returns that result at the top level; MCP nests it under `result`. Results include `output,report,files,slides|questions,issues`. Reports are arrays of `{path,kind,reason}` in `<output>.export-report.json`. Existing output or report files are refused: move the previous pair or choose a fresh filename.

PPTX uses 9525 EMU per CSS pixel, document slide order, editable title placeholders, text, basic shapes/lines, buttons, PNG/JPEG/GIF/BMP/TIFF images, alt descriptions and speaker notes. Rich paragraphs and runs (section 9) export as DrawingML runs. Unsupported image formats (including SVG/WebP), hidden objects and interactions are reported; custom shapes become rectangles. Fonts may substitute on the destination machine. Check title overlap after import.

Questions map TF, MC, MR, FIB, drop-down matching (MDN) and drag sequence (SD). Lesson question blocks are included, with 10 points each. There is no numeric type in this schema. Hotspot/freeform drag-and-drop, non-importable matching sets, blank prompts and questions with more than ten answers or points outside integer -1000..1000 are skipped and reported. Per-choice feedback is retained where available, with correct/incorrect question feedback as fallback. Other quiz settings are reported.

There is no documented literal escape for question delimiters. Learner-text `|`, `*` and `//` become visible fullwidth equivalents, and newlines/tabs become spaces; every modified field is reported. Inspect wording and accepted fill-in answers after import. XLSX stores literal strings, never formulas. Its first sheet has no header: type, points, prompt, then answers. TXT uses an assumed type/points/prompt/choices block with blank lines between questions; **the lead must confirm this by importing into Storyline**. Prefer XLSX.

To preserve interactions, publish Web, then choose **Insert > Web Object** in Storyline and select the folder with `index.html` at its root. Keep all files/subfolders together and display the Web Object at the course stage size. The iframe embeds the independent player; its objects are not editable Storyline objects and it does not automatically forward scores to the host Storyline quiz.
