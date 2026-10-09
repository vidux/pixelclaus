# Workflow: animation

**Model** — frames have durations (ms); tags name ranges {from,to} with direction forward|reverse|pingpong|pingpong_reverse and repeat (0 = loop). Cels are a layer's image at a frame; linked cels share one image (edit once, all frames change — results warn you). Continuous layers link new frames automatically.

**Steps**
1. Draw the key pose on frame 0. Put static parts (body, background props) and moving parts (arms, hair, FX) on separate layers.
2. frame {action:"duplicate", frame:0, count:N} copies frames. Keep static layers shared: mark them continuous (layer {action:"update", continuous:true}) before adding frames, or link existing cels with cel {action:"link"} — then an edit on one frame updates all of them.
3. Key poses first (e.g. contact L / contact R; anticipation / strike / recovery) with long holds, then breakdowns, then in-betweens. Add an in-between only where analyze kind animation (or render view diff) shows a part jumping more than 2 px between neighbouring frames.
4. Move whole parts with cel {action:"move", dx, dy} (cheap, exact) or draw op stamp {from:{frame}, dx, dy}; interpolate offsets with cel {action:"tween"}.
5. Timing via durations, not frame count: frame {action:"duration", frames, durations:[…]}.
6. tag {action:"add", name:"walk", from, to}.

**Typical cycles** — sprites animate in place (treadmill): the character's position does not advance; the game moves it. At 16-32 px use the low end of each frame count; bigger sprites get more in-betweens.
- idle: 2-4 frames @ 180-250 ms, 1 px bob
- walk: 4 @ 120 ms (contact, down, passing, up) · 6 @ 100 · 8 @ 80
- run: 6-8 @ 60-80 ms, lean 1-2 px, one airborne frame
- attack: anticipation 120-180 → smear 40-60 → strike hold 80-120 → recovery 2×100
- jump: crouch 100 · launch 60 · rise · apex · fall · land/squash 80 (separate tags)
- hit: 2-3 @ 70-90 with 1-2 px knockback, flash via palette · death: 4-8 @ 100-150, last 400+

**Principles** — 1-frame anticipation; one smear frame for fast motion; squash/stretch ≤ 1 px at 16 px (2 px at 32); feet on the same baseline row on contact frames; secondary motion (hair, cape) lags 1 frame; key-pose silhouettes must differ; sub-pixel motion = shift an edge pixel one ramp step instead of moving it.

**You cannot watch playback** — use instead:
- render view filmstrip {tag, baseline:<feet row>} — all frames side by side with ms; ping-pong unrolled
- render view onion {frame, onion:{prev:1, next:1, mode}} — mode "outline" (default): current frame dimmed, previous frame's silhouette edge red, next blue (overlaps stay visible); mode "tint": red/blue ghosts under the current frame
- render view diff {frame, compareFrame} — added magenta, removed cyan, recoloured yellow + counts; analyze kind diff gives the numbers, the best-fit shift and an ASCII change map
- render view trail — centroid path · render view timing — duration bars
- analyze kind animation {tag} — per-frame bbox, centroid, bottom row, changed pixels (most reliable)
- analyze kind lint — baseline-drift, frame-jitter, size-drift
