# CourseForge Studio command reference

Generated from the registry (`cf commands --markdown`). Every command works identically from the editor, `cf cmd`, the HTTP API and the MCP tool `run_commands`.

## course.set

Set course title, description, language, slide size, mode (slides|lessons; switching swaps slidesViewed/lessonsViewed tracking) or lessons cover {image, alt} (null removes).

| arg | type | notes |
|---|---|---|
| title | string |  |
| description | string |  |
| language | string |  |
| size | object |  |
| mode | string | one of: slides, lessons |
| cover | object\|null | lessons mode cover page image |

Examples:

```json
{"cmd":"course.set","args":{"title":"Lab Safety 101","size":{"w":1280,"h":720}}}
```
```json
{"cmd":"course.set","args":{"mode":"lessons","title":"Lab Basics","description":"Three short lessons and a quiz."}}
```

## player.set

Player options: style (modern|classic), menu, prev/next buttons, resume behavior (prompt|always|never), theme tokens.

| arg | type | notes |
|---|---|---|
| style | string | one of: modern, classic; Native player selection; modern uses CF charcoal chrome unless theme tokens override it |
| menu | boolean |  |
| prevNext | boolean |  |
| resume | string | one of: prompt, always, never |
| theme | object |  |
| navigation | string | one of: free, restricted; lessons mode: free (default) or restricted (in sequence; no search) |

Examples:

```json
{"cmd":"player.set","args":{"menu":true,"prevNext":true,"resume":"prompt"}}
```

## theme.apply

Apply a theme preset and/or font to both players. preset: auto|light|charcoal|ocean|forest|high-contrast (writes the full preset token set into player.theme, replacing the previous preset; auto removes it so the player uses its selected style or device setting; presets are explicit schemes). font: system|serif|rounded|mono (system font stacks; system removes the font tokens). Other custom theme tokens stay; the theme.list query shows every preset's tokens.

| arg | type | notes |
|---|---|---|
| preset | string | one of: auto, light, charcoal, ocean, forest, high-contrast |
| font | string | one of: system, serif, rounded, mono |

Examples:

```json
{"cmd":"theme.apply","args":{"preset":"charcoal"}}
```
```json
{"cmd":"theme.apply","args":{"preset":"ocean","font":"serif"}}
```
```json
{"cmd":"theme.apply","args":{"preset":"auto"}}
```

## tracking.set

LMS completion criteria (first met wins) and status reporting mode.

| arg | type | notes |
|---|---|---|
| complete | array |  |
| status | string | one of: passed-incomplete, passed-failed, completed-incomplete, completed-failed |

Examples:

```json
{"cmd":"tracking.set","args":{"complete":[{"quiz":"qz-final"}],"status":"passed-failed"}}
```
```json
{"cmd":"tracking.set","args":{"complete":[{"slidesViewed":100}]}}
```

## outline.add

Scaffold content from a structured outline (AI generation hook): each section becomes a scene (slides mode) or a section (lessons mode); each item becomes a slide or a lesson with its title, text and bullets; an item question becomes a question slide or a knowledge-check block. Deterministic for a given rng; returns the new ids.

| arg | type | notes |
|---|---|---|
| sections | array |  |
| text | string | the same outline as plain text instead of sections: "# Section", "## Item", text lines, "- bullet", "? question" then "[x] correct" / "[ ] wrong" choices (two or more [x] = multiple response) or "= accepted answer" lines (fill-in) |

Examples:

```json
{"cmd":"outline.add","args":{"sections":[{"title":"Basics","items":[{"title":"Why it matters","text":"Most incidents start small.","bullets":["Wear goggles","Label everything"],"question":{"type":"mc","prompt":"What first?","choices":[{"label":"Goggles","correct":true},{"label":"Coffee"}]}}]}]}}
```
```json
{"cmd":"outline.add","args":{"text":"# Basics\n## Why it matters\nMost incidents start small.\n- Wear goggles\n? What first?\n[x] Goggles\n[ ] Coffee"}}
```

## scene.add

Add a scene (a group of slides).

| arg | type | notes |
|---|---|---|
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| index | integer |  |

Examples:

```json
{"cmd":"scene.add","args":{"title":"Module 1"}}
```

## scene.set

Rename a scene.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |

Examples:

```json
{"cmd":"scene.set","args":{"id":"sc-1","title":"Intro"}}
```

## scene.move

Reorder a scene.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| index | integer | **required** |

Examples:

```json
{"cmd":"scene.move","args":{"id":"sc-2","index":0}}
```

## scene.remove

Remove a scene; its slides must be moved first unless force:true (then they are deleted too).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| force | boolean |  |

Examples:

```json
{"cmd":"scene.remove","args":{"id":"sc-2"}}
```

## bank.add

Add a question bank: slides kept outside the flow that draw slides pick from (add slides with slide.add {bank}).

| arg | type | notes |
|---|---|---|
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| index | integer |  |

Examples:

```json
{"cmd":"bank.add","args":{"id":"bk-safety","title":"Safety questions"}}
```

## bank.set

Rename a question bank.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |

Examples:

```json
{"cmd":"bank.set","args":{"id":"bk-safety","title":"Lab safety"}}
```

## bank.remove

Delete a question bank. Refused while a draw slide uses it; its slides must be moved first unless force:true (then they are deleted too).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| force | boolean |  |

Examples:

```json
{"cmd":"bank.remove","args":{"id":"bk-old"}}
```

## slide.add

Add a slide (optionally with objects, layers, triggers and a question in one go) to a scene, or with bank to a question bank (outside the flow; reached through draw slides).

| arg | type | notes |
|---|---|---|
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| scene | string | `^[a-z][a-z0-9-]{0,40}$` |
| bank | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| title | string |  |
| duration | number |  |
| advance | string | one of: user, auto |
| revisit | string | one of: auto, reset, resume |
| background | string |  |
| notes | string |  |
| objects | array |  |
| layers | array |  |
| triggers | array |  |
| question | object |  |

Examples:

```json
{"cmd":"slide.add","args":{"title":"Welcome","objects":[{"id":"o-title","type":"text","x":80,"y":60,"w":800,"h":80,"text":"Welcome!"}]}}
```
```json
{"cmd":"slide.add","args":{"id":"s-q1","title":"Check","question":{"type":"mc","prompt":"Pick B","choices":[{"id":"a","label":"A"},{"id":"b","label":"B","correct":true}]}}}
```
```json
{"cmd":"slide.add","args":{"id":"s-b1","bank":"bk-safety","title":"Bank question 1","question":{"type":"tf","prompt":"Goggles protect your eyes","choices":[{"id":"t","label":"True","correct":true},{"id":"f","label":"False"}]}}}
```

## slide.set

Change slide properties (title, duration ms, advance user|auto, revisit auto|reset|resume, background, notes). background/notes: null removes.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| duration | number |  |
| advance | string | one of: user, auto |
| revisit | string | one of: auto, reset, resume |
| background | string\|null |  |
| notes | string\|null |  |

Examples:

```json
{"cmd":"slide.set","args":{"id":"s-intro","revisit":"reset","advance":"auto"}}
```
```json
{"cmd":"slide.set","args":{"id":"s-intro","background":null}}
```

## slide.move

Move a slide within its scene or bank (index), to another scene (scene), into a question bank (bank) or from a bank back into the flow (scene).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| scene | string | `^[a-z][a-z0-9-]{0,40}$` |
| bank | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |

Examples:

```json
{"cmd":"slide.move","args":{"id":"s-q1","index":0}}
```
```json
{"cmd":"slide.move","args":{"id":"s-q1","scene":"sc-2"}}
```
```json
{"cmd":"slide.move","args":{"id":"s-q1","bank":"bk-safety"}}
```

## slide.import

Insert a reusable slide package (from the slide.export query, possibly from another course) with fresh ids. Missing variables and assets are added; triggers that point at slides, scenes or quizzes this course lacks are skipped (result.skipped).

| arg | type | notes |
|---|---|---|
| data | object | **required** |
| scene | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| newId | string | `^[a-z][a-z0-9-]{0,40}$` |

## slide.duplicate

Duplicate a slide (new ids for everything inside) right after the original.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| newId | string | `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |

Examples:

```json
{"cmd":"slide.duplicate","args":{"id":"s-intro","title":"Intro (copy)"}}
```

## slide.remove

Delete a slide. Fails if jumps/quizzes reference it unless force:true (removes those triggers/entries).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| force | boolean |  |

Examples:

```json
{"cmd":"slide.remove","args":{"id":"s-old"}}
```

## draw.add

Add a draw slide to a scene: when the learner reaches it, count slides are picked from the bank (count 0 = all; shuffle: random order, else bank order; always/never: bank slides always or never included). Quizzes may list the draw slide; they then score the drawn questions only.

| arg | type | notes |
|---|---|---|
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| scene | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| bank | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| count | integer | slides drawn; 0 = every eligible slide |
| shuffle | boolean | true: random order (pick order); false: bank order |
| always | array | bank slides always included |
| never | array | bank slides never included |

Examples:

```json
{"cmd":"draw.add","args":{"id":"s-draw","bank":"bk-safety","count":5}}
```
```json
{"cmd":"draw.add","args":{"bank":"bk-safety","count":3,"shuffle":false,"always":["s-b1"],"never":["s-b4"],"title":"Safety check"}}
```

## draw.set

Change a draw slide: bank (always/never are cleared unless given), count, shuffle, always, never, title.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| bank | string | `^[a-z][a-z0-9-]{0,40}$` |
| count | integer | slides drawn; 0 = every eligible slide |
| shuffle | boolean | true: random order (pick order); false: bank order |
| always | array | bank slides always included |
| never | array | bank slides never included |

Examples:

```json
{"cmd":"draw.set","args":{"id":"s-draw","count":10}}
```
```json
{"cmd":"draw.set","args":{"id":"s-draw","always":["s-b2"],"never":[]}}
```

## object.add

Add an object to a slide (or one of its layers). Types: text, shape, button, image, hotspot, input, slider, dial, video, audio, marker. Later objects draw on top.

| arg | type | notes |
|---|---|---|
| slide | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| layer | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| type | string | **required**; one of: text, shape, button, image, hotspot, input, slider, dial, video, audio, marker |
| name | string |  |
| x | number |  |
| y | number |  |
| w | number |  |
| h | number |  |
| rotation | number |  |
| text | string |  |
| rich | array | Paragraphs; text mirrors their runs joined by newlines. Text/shape/button only. |
| style | object | Visual overrides; colors are CSS hex like #0b6e6e. |
| image | string | `^[a-z][a-z0-9-]{0,40}$` |
| alt | string |  |
| shape | string | one of: rect, rounded, ellipse, line, arrow; line/arrow: a stroke along the box centre line from left to right (arrow: head at the right end), turned by rotation; stroke = style.border and style.borderWidth |
| hidden | boolean |  |
| locked | boolean | editor only: the object cannot be dragged, resized or nudged on the canvas (imported master/layout objects) |
| initialState | string |  |
| states | object |  |
| start | number |  |
| end | number\|null |  |
| enter | object | entrance effect: plays from the object start for its duration |
| exit | object | exit effect: ends at the object end, starting at end - duration; ignored without an end |
| var | string | `^(?!__)[A-Za-z_][A-Za-z0-9_]*$`; input: bound text variable; slider/dial: bound number variable (required) |
| placeholder | string |  |
| tabIndex | integer |  |
| maxLength | integer | input: most characters the learner can type (default 400; SCORM 1.2 resume data holds 4096 characters for the whole course) |
| report | boolean | input: report the answer to the LMS as an ungraded fill-in interaction (result neutral, no score) when the learner leaves the slide; needs var |
| min | number | slider/dial: value at the start (default 0) |
| max | number | slider/dial: value at the end (default 10 for a slider, 12 for a dial) |
| step | number | slider/dial: values snap to min + n*step (default 1) |
| live | boolean | slider/dial: update the variable while dragging (default true) or on release |
| startAngle | number | dial: pointer angle at min, degrees clockwise from 12 o'clock (default -90) |
| endAngle | number | dial: pointer angle at max (default 90) |
| media | string | `^[a-z][a-z0-9-]{0,40}$`; video/audio: asset id of the media file (kept as is: mp4, webm, mp3, wav...) |
| captions | string | `^[a-z][a-z0-9-]{0,40}$`; video/audio: asset id of a WebVTT (.vtt) captions file; captions start hidden (CC button, Ctrl+Alt+C) |
| poster | string | `^[a-z][a-z0-9-]{0,40}$`; video: asset id of the poster image |
| autoplay | boolean | video/audio: play when the object appears (default false) |
| controls | boolean | video/audio: native player controls (default true); without them a click on a video plays or pauses it |
| loop | boolean | video/audio: repeat (default false); a looping medium never ends |
| detail | string | marker: the label text shown while the marker is open (text is its title) |
| members | array | Imported simple drag group: visible base-layer objects carried by this transparent hotspot. |

Examples:

```json
{"cmd":"object.add","args":{"slide":"s-intro","type":"button","id":"o-start","text":"Start","x":540,"y":600,"w":200,"h":56}}
```
```json
{"cmd":"object.add","args":{"slide":"s-intro","layer":"l-help","type":"text","text":"Hint: %score% points so far"}}
```

## object.set

Change object properties (geometry, text, style (merged; a key set to null is removed), image, alt, hidden, timing start/end ms, initialState...). null deletes an optional field. rich derives text; setting text without rich replaces formatting with plain text.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| name | string\|null |  |
| x | number\|null |  |
| y | number\|null |  |
| w | number\|null |  |
| h | number\|null |  |
| rotation | number\|null |  |
| text | string\|null |  |
| rich | array\|null | Paragraphs; text mirrors their runs joined by newlines. Text/shape/button only. |
| style | object\|null | Visual overrides; colors are CSS hex like #0b6e6e. |
| image | string\|null | `^[a-z][a-z0-9-]{0,40}$` |
| alt | string\|null |  |
| shape | string\|null | one of: rect, rounded, ellipse, line, arrow, ; line/arrow: a stroke along the box centre line from left to right (arrow: head at the right end), turned by rotation; stroke = style.border and style.borderWidth |
| hidden | boolean\|null |  |
| locked | boolean\|null | editor only: the object cannot be dragged, resized or nudged on the canvas (imported master/layout objects) |
| initialState | string\|null |  |
| states | object\|null |  |
| start | number\|null |  |
| end | number\|null\|null |  |
| enter | object\|null | entrance effect: plays from the object start for its duration |
| exit | object\|null | exit effect: ends at the object end, starting at end - duration; ignored without an end |
| var | string\|null | `^(?!__)[A-Za-z_][A-Za-z0-9_]*$`; input: bound text variable; slider/dial: bound number variable (required) |
| placeholder | string\|null |  |
| tabIndex | integer\|null |  |
| maxLength | integer\|null | input: most characters the learner can type (default 400; SCORM 1.2 resume data holds 4096 characters for the whole course) |
| report | boolean\|null | input: report the answer to the LMS as an ungraded fill-in interaction (result neutral, no score) when the learner leaves the slide; needs var |
| min | number\|null | slider/dial: value at the start (default 0) |
| max | number\|null | slider/dial: value at the end (default 10 for a slider, 12 for a dial) |
| step | number\|null | slider/dial: values snap to min + n*step (default 1) |
| live | boolean\|null | slider/dial: update the variable while dragging (default true) or on release |
| startAngle | number\|null | dial: pointer angle at min, degrees clockwise from 12 o'clock (default -90) |
| endAngle | number\|null | dial: pointer angle at max (default 90) |
| media | string\|null | `^[a-z][a-z0-9-]{0,40}$`; video/audio: asset id of the media file (kept as is: mp4, webm, mp3, wav...) |
| captions | string\|null | `^[a-z][a-z0-9-]{0,40}$`; video/audio: asset id of a WebVTT (.vtt) captions file; captions start hidden (CC button, Ctrl+Alt+C) |
| poster | string\|null | `^[a-z][a-z0-9-]{0,40}$`; video: asset id of the poster image |
| autoplay | boolean\|null | video/audio: play when the object appears (default false) |
| controls | boolean\|null | video/audio: native player controls (default true); without them a click on a video plays or pauses it |
| loop | boolean\|null | video/audio: repeat (default false); a looping medium never ends |
| detail | string\|null | marker: the label text shown while the marker is open (text is its title) |
| members | array\|null | Imported simple drag group: visible base-layer objects carried by this transparent hotspot. |

Examples:

```json
{"cmd":"object.set","args":{"id":"o-start","x":560,"text":"Begin","style":{"fill":"#0b6e6e","color":"#ffffff"}}}
```
```json
{"cmd":"object.set","args":{"id":"o-start","style":{"fill":null}}}
```

## object.move

Change z-order (index; 0 = back) and/or move to a layer of the same slide (layer: null = base).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| layer | string\|null |  |

Examples:

```json
{"cmd":"object.move","args":{"id":"o-start","index":0}}
```
```json
{"cmd":"object.move","args":{"id":"o-hint","layer":"l-help"}}
```

## object.remove

Delete an object. Fails if triggers reference it unless force:true (removes those triggers).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| force | boolean |  |

Examples:

```json
{"cmd":"object.remove","args":{"id":"o-old"}}
```

## object.duplicate

Copy objects (same slide and layer) with fresh ids, plus the triggers they fire, remapping references to the copies. Omit slide and layer to copy in place; else paste onto slide (default: source slide) and layer (default/null: base). dx/dy offset the copies. Copied triggers that would reference missing objects/layers at the destination are skipped (result.skipped).

| arg | type | notes |
|---|---|---|
| ids | array | **required** |
| slide | string | `^[a-z][a-z0-9-]{0,40}$` |
| layer | string\|null | `^[a-z][a-z0-9-]{0,40}$` |
| dx | number |  |
| dy | number |  |
| newIds | array |  |

Examples:

```json
{"cmd":"object.duplicate","args":{"ids":["o-start"],"dx":20,"dy":20}}
```
```json
{"cmd":"object.duplicate","args":{"ids":["o-card","o-flip"],"slide":"s-two","layer":"l-info","newIds":["o-card2","o-flip2"]}}
```

## object.align

Align objects by edge or center: left|center|right (x), top|middle|bottom (y), to the selection bounds (default for 2+ objects) or the slide (default for one). Rotation is ignored.

| arg | type | notes |
|---|---|---|
| ids | array | **required** |
| edge | string | **required**; one of: left, center, right, top, middle, bottom |
| to | string | one of: selection, slide |

Examples:

```json
{"cmd":"object.align","args":{"ids":["o-a","o-b","o-c"],"edge":"left"}}
```
```json
{"cmd":"object.align","args":{"ids":["o-title"],"edge":"center","to":"slide"}}
```

## object.distribute

Space 3+ objects evenly (equal gaps) horizontally or vertically; the outermost objects stay put.

| arg | type | notes |
|---|---|---|
| ids | array | **required** |
| axis | string | **required**; one of: horizontal, vertical |

Examples:

```json
{"cmd":"object.distribute","args":{"ids":["o-a","o-b","o-c"],"axis":"horizontal"}}
```

## state.set

Define or update an object state (overrides of style/text/image/hidden; style is merged, a key set to null is removed; null removes an override). Built-ins: normal, hover, down, selected, visited, disabled, hidden; custom names allowed.

| arg | type | notes |
|---|---|---|
| target | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| state | string | **required**; `^[a-z][a-z0-9_-]*$` |
| style | object\|null | Visual overrides; colors are CSS hex like #0b6e6e. |
| text | string\|null |  |
| image | string\|null | `^[a-z][a-z0-9-]{0,40}$` |
| hidden | boolean\|null |  |

Examples:

```json
{"cmd":"state.set","args":{"target":"o-start","state":"hover","style":{"fill":"#095c5c"}}}
```
```json
{"cmd":"state.set","args":{"target":"o-card","state":"flipped","text":"Answer: 42"}}
```
```json
{"cmd":"state.set","args":{"target":"o-start","state":"hover","style":{"fill":null}}}
```

## state.remove

Remove a state definition from an object.

| arg | type | notes |
|---|---|---|
| target | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| state | string | **required** |

Examples:

```json
{"cmd":"state.remove","args":{"target":"o-card","state":"flipped"}}
```

## layer.add

Add a layer to a slide (hidden until a showLayer action). Props: hideOthers, hideBaseObjects, hideOnEnd, modal, pauseBase, revisit.

| arg | type | notes |
|---|---|---|
| slide | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| title | string |  |
| duration | number |  |
| hideOthers | boolean |  |
| hideBaseObjects | boolean |  |
| hideOnEnd | boolean |  |
| modal | boolean |  |
| pauseBase | boolean |  |
| revisit | string | one of: auto, reset, resume |
| objects | array |  |
| triggers | array |  |

Examples:

```json
{"cmd":"layer.add","args":{"slide":"s-intro","id":"l-help","title":"Help","modal":true}}
```

## layer.set

Change layer properties.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| duration | number |  |
| hideOthers | boolean |  |
| hideBaseObjects | boolean |  |
| hideOnEnd | boolean |  |
| modal | boolean |  |
| pauseBase | boolean |  |
| revisit | string | one of: auto, reset, resume |

Examples:

```json
{"cmd":"layer.set","args":{"id":"l-help","pauseBase":true}}
```

## layer.move

Reorder a layer within its slide (index 0 = first in the list).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| index | integer | **required** |

Examples:

```json
{"cmd":"layer.move","args":{"id":"l-help","index":0}}
```

## layer.remove

Delete a layer and its objects. Fails if referenced unless force:true.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| force | boolean |  |

Examples:

```json
{"cmd":"layer.remove","args":{"id":"l-help"}}
```

## trigger.add

Add a trigger to a slide (or layer): on <event> [if <conditions>] do <actions> [else <actions>]. Actions run in order; a jump ends the rest.

| arg | type | notes |
|---|---|---|
| slide | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| layer | string | `^[a-z][a-z0-9-]{0,40}$` |
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| name | string |  |
| on | object | **required** |
| if | object |  |
| do | array | **required** |
| else | array |  |
| enabled | boolean |  |

Examples:

```json
{"cmd":"trigger.add","args":{"slide":"s-intro","on":{"event":"click","target":"o-start"},"do":[{"action":"setVar","var":"started","op":"set","value":true},{"action":"jump","to":"next"}]}}
```
```json
{"cmd":"trigger.add","args":{"slide":"s-q1","on":{"event":"click","target":"o-hint"},"if":{"all":[{"var":"score","op":"<","value":50}]},"do":[{"action":"showLayer","layer":"l-help"}],"else":[{"action":"setState","target":"o-hint","state":"disabled"}]}}
```

## trigger.set

Replace parts of a trigger (on, if, do, else, name, enabled). if/else/name: null removes.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| name | string\|null |  |
| on | object |  |
| if | object\|null |  |
| do | array |  |
| else | array\|null |  |
| enabled | boolean |  |

Examples:

```json
{"cmd":"trigger.set","args":{"id":"t-start","do":[{"action":"jump","to":"s-q1"}]}}
```
```json
{"cmd":"trigger.set","args":{"id":"t-start","if":null}}
```

## trigger.move

Reorder a trigger within its list (execution order).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| index | integer | **required** |

Examples:

```json
{"cmd":"trigger.move","args":{"id":"t-2","index":0}}
```

## trigger.remove

Delete a trigger.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |

Examples:

```json
{"cmd":"trigger.remove","args":{"id":"t-2"}}
```

## var.add

Declare a course variable (number|boolean|text). Use %name% in text to display it.

| arg | type | notes |
|---|---|---|
| name | string | **required**; `^(?!__)[A-Za-z_][A-Za-z0-9_]*$` |
| type | string | **required**; one of: number, boolean, text |
| initial | number\|string\|boolean |  |

Examples:

```json
{"cmd":"var.add","args":{"name":"score","type":"number","initial":0}}
```
```json
{"cmd":"var.add","args":{"name":"visitedLab","type":"boolean","initial":false}}
```

## var.set

Change a variable initial value or rename it (references and %name% text are updated).

| arg | type | notes |
|---|---|---|
| name | string | **required** |
| newName | string | `^(?!__)[A-Za-z_][A-Za-z0-9_]*$` |
| initial | number\|string\|boolean |  |

Examples:

```json
{"cmd":"var.set","args":{"name":"score","initial":10}}
```
```json
{"cmd":"var.set","args":{"name":"score","newName":"points"}}
```

## var.remove

Delete a variable. Fails if used unless force:true (removes those triggers).

| arg | type | notes |
|---|---|---|
| name | string | **required** |
| force | boolean |  |

Examples:

```json
{"cmd":"var.remove","args":{"name":"tmp"}}
```

## question.set

Make a slide a question slide or update its question (mc|mr|tf|fill|hotspot|dragdrop|matching|sequence). Fields are merged; choices/answers/areas/items/targets/rows are replaced (null removes areas, items, targets or rows).

| arg | type | notes |
|---|---|---|
| slide | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| type | string | one of: mc, mr, tf, fill, hotspot, dragdrop, matching, sequence; matching: rows, each answered with one of choices (a drop-down list per row); sequence: choices are the items in their correct order |
| prompt | string |  |
| layout | object | Authored choice-question boxes in slide coordinates; choices array is the visual slot order before shuffling. |
| rows | array\|null | matching: statements; choice = id of the correct choice (several rows may share one) |
| items | array\|null | dragdrop: drag items (base-layer objects of the slide); target = the correct target object, absent = distractor |
| targets | array\|null | dragdrop: drop targets (base-layer objects); capacity one (default: centred, a new drop replaces the occupant) or many (stacked) |
| areas | array\|null | hotspot: click areas in slide coordinates; the first area containing the point decides |
| choices | array |  |
| answers | array |  |
| caseSensitive | boolean |  |
| points | number |  |
| attempts | integer | 0 = unlimited (Storyline files store 10000) |
| shuffle | boolean |  |
| feedback | object |  |

Examples:

```json
{"cmd":"question.set","args":{"slide":"s-q1","type":"mc","prompt":"Which gas do plants absorb?","choices":[{"id":"a","label":"Oxygen"},{"id":"b","label":"Carbon dioxide","correct":true}],"points":10,"attempts":2}}
```
```json
{"cmd":"question.set","args":{"slide":"s-q2","type":"fill","prompt":"Type the color","answers":["teal","teal blue"]}}
```
```json
{"cmd":"question.set","args":{"slide":"s-q3","type":"hotspot","prompt":"Click the fire extinguisher","areas":[{"id":"ext","x":820,"y":260,"w":140,"h":260,"correct":true},{"id":"door","shape":"ellipse","x":200,"y":200,"w":180,"h":300}]}}
```
```json
{"cmd":"question.set","args":{"slide":"s-q4","type":"dragdrop","prompt":"Sort the waste","items":[{"object":"o-glass","target":"o-bin-sharps"},{"object":"o-gloves","target":"o-bin-bio"},{"object":"o-paper"}],"targets":[{"object":"o-bin-sharps"},{"object":"o-bin-bio","capacity":"many"}]}}
```
```json
{"cmd":"question.set","args":{"slide":"s-q5","type":"matching","prompt":"Match each hazard to its sign","choices":[{"id":"bio","label":"Biohazard"},{"id":"rad","label":"Radiation"}],"rows":[{"id":"blood","label":"Blood sample","choice":"bio"},{"id":"isotope","label":"Isotope","choice":"rad"}]}}
```
```json
{"cmd":"question.set","args":{"slide":"s-q6","type":"sequence","prompt":"Put the steps in order","choices":[{"id":"wash","label":"Wash hands"},{"id":"gloves","label":"Put on gloves"},{"id":"work","label":"Start work"}]}}
```

## question.remove

Turn a question slide back into a normal slide.

| arg | type | notes |
|---|---|---|
| slide | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |

Examples:

```json
{"cmd":"question.remove","args":{"slide":"s-q1"}}
```

## quiz.add

Create a quiz from question slides with a pass mark (%) and optional results slide.

| arg | type | notes |
|---|---|---|
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| questions | array |  |
| passPercent | number |  |
| results | string | `^[a-z][a-z0-9-]{0,40}$` |
| round | boolean |  |

Examples:

```json
{"cmd":"quiz.add","args":{"id":"qz-final","questions":["s-q1","s-q2"],"passPercent":80,"results":"s-results"}}
```

## quiz.set

Change a quiz. review true|false adds or removes the Review quiz button on its results slide.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| questions | array |  |
| passPercent | number |  |
| results | string\|null | `^[a-z][a-z0-9-]{0,40}$` |
| round | boolean |  |
| review | boolean |  |

Examples:

```json
{"cmd":"quiz.set","args":{"id":"qz-final","passPercent":70}}
```
```json
{"cmd":"quiz.set","args":{"id":"qz-final","review":false}}
```

## quiz.addResults

Add a standard results slide for a quiz: score text, pass/fail layers, submit on start, Retry button (after a fail), Review quiz button (review: false leaves it out); optionally make the quiz the LMS completion criterion.

| arg | type | notes |
|---|---|---|
| quiz | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| scene | string | `^[a-z][a-z0-9-]{0,40}$` |
| passText | string |  |
| failText | string |  |
| retry | boolean |  |
| review | boolean |  |
| track | boolean |  |

Examples:

```json
{"cmd":"quiz.addResults","args":{"quiz":"qz-final","id":"s-results","track":true}}
```

## quiz.remove

Delete a quiz (question slides stay). Fails if referenced unless force:true.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| force | boolean |  |

Examples:

```json
{"cmd":"quiz.remove","args":{"id":"qz-final"}}
```

## section.add

Lessons mode: add a section (a labelled group of lessons in the outline; an empty title shows no header).

| arg | type | notes |
|---|---|---|
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| index | integer |  |

Examples:

```json
{"cmd":"section.add","args":{"id":"sec-basics","title":"Basics"}}
```

## section.set

Rename a section.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |

Examples:

```json
{"cmd":"section.set","args":{"id":"sec-basics","title":"Getting started"}}
```

## section.move

Reorder a section.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| index | integer | **required** |

Examples:

```json
{"cmd":"section.move","args":{"id":"sec-quiz","index":0}}
```

## section.remove

Remove a section; its lessons must be moved first unless force:true (then they are deleted with the buttons/tracking entries that point to them).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| force | boolean |  |

Examples:

```json
{"cmd":"section.remove","args":{"id":"sec-old"}}
```

## lesson.add

Lessons mode: add a lesson to a section (default: the last one). kind content = stacked blocks; kind quiz = question blocks graded one at a time (passPercent 80, attempts 0 = unlimited, reveal all|incorrect|none, randomize, shuffle, requirePass). blocks may be given inline; missing block ids are generated.

| arg | type | notes |
|---|---|---|
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| section | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| title | string |  |
| kind | string | one of: content, quiz |
| passPercent | number | quiz: pass mark %, default 80 |
| attempts | integer | quiz: attempts allowed, default 0 = unlimited |
| reveal | string | one of: all, incorrect, none; quiz: after each answer show result+feedback+correct answer (all, default), result+feedback (incorrect) or nothing (none) |
| randomize | boolean | quiz: random question order |
| shuffle | boolean | quiz: shuffle answer choices |
| requirePass | boolean | quiz: the lesson completes only when passed |
| blocks | array |  |

Examples:

```json
{"cmd":"lesson.add","args":{"id":"l-intro","section":"sec-basics","title":"Welcome","blocks":[{"type":"heading","text":"Welcome"},{"type":"text","text":"Two short paragraphs.\n\nA blank line starts the second one."}]}}
```
```json
{"cmd":"lesson.add","args":{"id":"l-quiz","title":"Final quiz","kind":"quiz","passPercent":80,"attempts":2,"reveal":"incorrect"}}
```

## lesson.set

Change a lesson: title, kind, quiz settings (passPercent, attempts, reveal, randomize, shuffle, requirePass; null removes).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |
| kind | string | one of: content, quiz |
| passPercent | number\|null | quiz: pass mark %, default 80 |
| attempts | integer\|null | quiz: attempts allowed, default 0 = unlimited |
| reveal | string\|null | one of: all, incorrect, none, ; quiz: after each answer show result+feedback+correct answer (all, default), result+feedback (incorrect) or nothing (none) |
| randomize | boolean\|null | quiz: random question order |
| shuffle | boolean\|null | quiz: shuffle answer choices |
| requirePass | boolean\|null | quiz: the lesson completes only when passed |

Examples:

```json
{"cmd":"lesson.set","args":{"id":"l-quiz","passPercent":70,"attempts":3}}
```
```json
{"cmd":"lesson.set","args":{"id":"l-intro","title":"Start here"}}
```

## lesson.move

Move a lesson within its section or to another section.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| section | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |

Examples:

```json
{"cmd":"lesson.move","args":{"id":"l-quiz","index":0}}
```
```json
{"cmd":"lesson.move","args":{"id":"l-quiz","section":"sec-check"}}
```

## lesson.duplicate

Duplicate a lesson (new ids for its blocks) right below the original.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| newId | string | `^[a-z][a-z0-9-]{0,40}$` |
| title | string |  |

Examples:

```json
{"cmd":"lesson.duplicate","args":{"id":"l-intro","title":"Welcome (copy)"}}
```

## lesson.import

Lessons mode: insert a reusable lesson package (from the lesson.export query, possibly from another course) with fresh ids into a section. Missing assets are added; buttons that point at lessons this course lacks are dropped (result.unlinked).

| arg | type | notes |
|---|---|---|
| data | object | **required** |
| section | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| newId | string | `^[a-z][a-z0-9-]{0,40}$` |

## lesson.remove

Delete a lesson. Fails if buttons or tracking point to it unless force:true (removes those).

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| force | boolean |  |

Examples:

```json
{"cmd":"lesson.remove","args":{"id":"l-old"}}
```

## block.add

Lessons mode: add a block to a lesson (default: at the end). Types: heading, text, list, quote, divider, image, imageText, gallery, video, audio, accordion, tabs, flashcards, labeledGraphic, process, timeline, button, continue, question, sorting, scenario. Collections are always "items". style: {width, padding, align, background, color}.

| arg | type | notes |
|---|---|---|
| lesson | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| style | object | Block layout and colors (CSS hex colors). |
| type=heading | variant | **text**, level |
| type=text | variant | **text**; plain text; a blank line starts a new paragraph |
| type=list | variant | kind, **items** |
| type=quote | variant | **text**, cite |
| type=divider | variant | (no fields) |
| type=image | variant | **image**, alt, caption |
| type=imageText | variant | **image**, alt, **text**, side |
| type=gallery | variant | columns, **items**[{image, alt, caption}] |
| type=video | variant | **media**, captions, title |
| type=audio | variant | **media**, captions, title |
| type=accordion | variant | **items**[{title, text}] |
| type=tabs | variant | **items**[{title, text}] |
| type=flashcards | variant | **items**[{front, back}] |
| type=labeledGraphic | variant | **image**, alt, **items**[{x, y, title, text}]; markers at x%/y% of the image |
| type=process | variant | intro, **items**[{title, text}], summary |
| type=timeline | variant | **items**[{date, title, text}] |
| type=button | variant | **label**, text, url, toLesson; exactly one of url (opens a new tab) or toLesson (a lesson id) |
| type=continue | variant | label, require; hides the blocks below until passed |
| type=question | variant | **kind**, **prompt**, choices[{id, label, correct, feedback}], answers, caseSensitive, pairs[{left, right}], feedback, attempts, hideCorrect, shuffle; knowledge check (ungraded) or, in a quiz lesson, a graded question |
| type=sorting | variant | **categories**, **items**[{text, category}] |
| type=scenario | variant | scenes[{id, title, background, backgroundAlt, character, characterAlt, items}], ending; branching dialogue: scenes of dialogue items (1 to 3 responses) and text items; complete when an end is reached. Omit scenes for a one-scene starter. |

Examples:

```json
{"cmd":"block.add","args":{"lesson":"l-intro","id":"b-acc","type":"accordion","items":[{"title":"Goggles","text":"Protect your eyes."},{"title":"Gloves","text":"Protect your hands."}]}}
```
```json
{"cmd":"block.add","args":{"lesson":"l-intro","type":"continue","require":"above","label":"Continue"}}
```
```json
{"cmd":"block.add","args":{"lesson":"l-intro","type":"question","kind":"mc","prompt":"Which protects your eyes?","choices":[{"id":"a","label":"Goggles","correct":true},{"id":"b","label":"Gloves"}],"feedback":{"correct":"Yes.","incorrect":"Look again."}}}
```
```json
{"cmd":"block.add","args":{"lesson":"l-intro","type":"button","label":"Take the quiz","toLesson":"l-quiz"}}
```

## block.set

Change block fields (any field of its type; type may switch, e.g. accordion <-> tabs; style is merged, a style key set to null is removed; null removes an optional field). Arrays such as items/choices are replaced.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| type | string | one of: heading, text, list, quote, divider, image, imageText, gallery, video, audio, accordion, tabs, flashcards, labeledGraphic, process, timeline, button, continue, question, sorting, scenario |
| style | object\|null | Block layout and colors (CSS hex colors). |
| text | string\|null |  |
| level | integer\|null | one of: 2, 3,  |
| kind | string\|null | shape depends on the block type |
| items | array\|null | shape depends on the block type |
| cite | string\|null |  |
| image | string\|null | `^[a-z][a-z0-9-]{0,40}$`; asset id |
| alt | string\|null |  |
| caption | string\|null |  |
| side | string\|null | one of: left, right,  |
| columns | integer\|null | one of: 2, 3, 4,  |
| media | string\|null | `^[a-z][a-z0-9-]{0,40}$`; asset id |
| captions | string\|null | `^[a-z][a-z0-9-]{0,40}$`; asset id of a WebVTT (.vtt) captions file |
| title | string\|null |  |
| intro | string\|null |  |
| summary | string\|null |  |
| label | string\|null |  |
| url | string\|null | `^(https?:|mailto:)` |
| toLesson | string\|null | `^[a-z][a-z0-9-]{0,40}$` |
| require | string\|null | one of: none, above, allAbove,  |
| prompt | string\|null |  |
| choices | array\|null |  |
| answers | array\|null |  |
| caseSensitive | boolean\|null |  |
| pairs | array\|null |  |
| feedback | object\|null |  |
| attempts | integer\|null | knowledge checks: submissions allowed, 0 or absent = unlimited |
| hideCorrect | boolean\|null |  |
| shuffle | boolean\|null |  |
| categories | array\|null |  |
| scenes | array\|null |  |
| ending | string\|null | text shown at the end, above Start over |

Examples:

```json
{"cmd":"block.set","args":{"id":"b-acc","type":"tabs"}}
```
```json
{"cmd":"block.set","args":{"id":"b-intro","text":"New text","style":{"width":"wide","background":"#f4f1ea"}}}
```
```json
{"cmd":"block.set","args":{"id":"b-intro","style":{"background":null}}}
```

## block.move

Reorder a block (index) and/or move it to another lesson.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| lesson | string | `^[a-z][a-z0-9-]{0,40}$` |
| index | integer |  |

Examples:

```json
{"cmd":"block.move","args":{"id":"b-acc","index":0}}
```
```json
{"cmd":"block.move","args":{"id":"b-acc","lesson":"l-two","index":2}}
```

## block.duplicate

Duplicate a block right below the original.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| newId | string | `^[a-z][a-z0-9-]{0,40}$` |

Examples:

```json
{"cmd":"block.duplicate","args":{"id":"b-acc"}}
```

## block.remove

Delete a block.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |

Examples:

```json
{"cmd":"block.remove","args":{"id":"b-old"}}
```

## asset.add

Register an asset: a file (path relative to the course file, e.g. assets/photo.png) or an original image from the CourseForge Studio library (library: an id from the library.list query; the path becomes library/<file> and alt comes from the library unless given). Pass path or library.

| arg | type | notes |
|---|---|---|
| id | string | `^[a-z][a-z0-9-]{0,40}$` |
| path | string | `^(?![a-zA-Z]:|/|\\)(?!.*\.\.)[^<>:"|?*]+$` |
| library | string | one of: goggles, gloves, lab-coat, face-mask, flask, test-tubes, microscope, thermometer, first-aid-kit, fire-extinguisher, warning-sign, waste-bin, shield, checkmark, cross, info, question, lightbulb, person, group, speech-bubble, clipboard, computer, book, clock, calendar, map-pin, target, trophy, star |
| mime | string |  |
| alt | string |  |

Examples:

```json
{"cmd":"asset.add","args":{"id":"a-logo","path":"assets/logo.png","alt":"Company logo"}}
```
```json
{"cmd":"asset.add","args":{"id":"a-goggles","library":"goggles"}}
```

## asset.remove

Delete an asset entry. Fails if objects use it unless force:true.

| arg | type | notes |
|---|---|---|
| id | string | **required**; `^[a-z][a-z0-9-]{0,40}$` |
| force | boolean |  |

Examples:

```json
{"cmd":"asset.remove","args":{"id":"a-logo"}}
```

## Publish targets

The shared I/O registry is packages/core/publish-targets.js. Use cf publish, MCP publish or POST /api/courses/:name/publish (not cf cmd).

| target | CLI output | publisher |
|---|---|---|
| web | --web outDir | publishWeb |
| scorm12 | --scorm12 outDir | publishScorm12 |
| pptx | --pptx out.pptx | publishPptx |
| questions | --questions out.xlsx | publishQuestions |

Questions also accept .txt. MCP: {file,target,out,zip?}. HTTP: {target,format?,zip?}, with format xlsx (default) or txt for questions. For scorm12, zip:true also creates an adjacent LMS upload ZIP. File exports return output, report, files, slides/questions and issues; reports are arrays of {path,kind,reason} in <output>.export-report.json. Existing output/report files are refused.

PowerPoint preserves editable base-slide visuals; unsupported interactions and approximations are reported. Question delimiters |, *, // use reported fullwidth substitutions; inspect accepted answers after import. TXT layout is assumed, so prefer XLSX. To retain interactions, publish web and insert the folder containing index.html as a Storyline Web Object.

