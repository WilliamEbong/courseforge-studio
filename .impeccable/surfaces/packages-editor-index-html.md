---
version: 1
slug: "packages-editor-index-html"
primary_target: "packages/editor/index.html"
related_targets: []
---

Scope: the start screen of the editor (the course picker shown when no course is open), plus its AI connection surface. Visitor mode: Operate.

Audience and job: instructional designers and SMEs opening the app to continue a course, start a new one (with Claude, from an outline, blank) or bring in a .story file. First-run users must see the demo courses and know whether Claude is connected.

Constraints: inherit the editor's world (system sans, 13px dense UI, teal accent, light and dark tokens in editor.css). Keep existing ids (#picker, .course-list button, new-course and import fields) working for the e2e suite. WCAG 2.2 AA.

## Direction contract
THESIS: The start screen is a shelf of the author's real courses, each cover a live miniature of its own first slide drawn from the course model; it refuses the category's grey list of filenames.
OWN-WORLD: The editor's neutral panels and teal accent; covers are the stage's own pasteboard and slide colours at 16:9, titled in the UI sans; type badges Slides/Lessons; the start strip is a row of four equal-weight action tiles with drawn icons, Create with AI carrying the teal fill.
STORY: The author sees their courses as they look, opens one in one click, or starts a new one; a status line says whether Claude is ready and how to connect it.
FIRST VIEWPORT: Brand bar; a start strip of four actions across the width (Create with AI, From an outline, Blank course, Import .story); a responsive grid of covers (3 to 4 per row at 1440) with title, type, last edited; an AI status line under the strip.
FORM: Course shelf, position 3 on the ordered list; seed key 3a002bfd.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
