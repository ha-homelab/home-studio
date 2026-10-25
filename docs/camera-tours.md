# Camera tours and local video

Camera tours save named viewpoints and replay them in an ordered route. Use
them to show a room, compare angles, or record a short walkthrough of your
model. They are available in the planner's 3D preview and the generated
Home/Editor viewer.

## Start with a full orbit

Open **Camera tour** in a 3D view. On first open, a 20-second, 360° route is
ready: five editable views turn through four quarter circles, return to the
starting angle and hold for one second. Opening the panel does not move the
camera or start playback. Choose **Play** to preview it, or **Record video** to
play it from the beginning and save an MP4 when your browser supports recording.

In Preview 3D, the orbit fits the complete visible floor or floors using the
preview's fit calculation. In generated Editor, it fits the whole house's
static geometry. Both retain your viewing tilt and starting angle instead of
orbiting a previously focused room. In Home, it frames the whole house with
centered pan and a standard zoom, retaining your viewing tilt and starting angle.
Whole-house framing includes static porches and yard structures outside room
footprints, while excluding decorative backdrops and moving objects. That
framing takes effect when you preview, play or record the route.

**Full orbit** replaces the current route with this whole-house or visible-floor
fit, using your current viewing angle. **Save current view** still saves the
exact framing you chose for a custom route. Export your route first if you want
to keep it. Closing and
reopening the panel preserves your edits, imported route or deliberately empty
route for the current page session; it does not reset the orbit. In Home,
return from the map overview to the house
before using the tour. If its initial view was unavailable, choose **Full
orbit** after returning to prepare the route.

## Make a custom route

![Save viewpoints, arrange their order, play the route and export a local video](images/camera-tour-workflow.svg)

1. Choose **Clear route** to start from scratch, or edit the default orbit's
   views. Position the camera with the usual orbit, pan and zoom controls, then
   select **Save current view** to append a viewpoint.
2. Give it a recognizable name, such as **Entrance**, **Living area** or
   **Garden**. Move the camera and add the next view.
3. Move views up or down to set their order. Preview a saved view to check its
   framing, or remove it if it no longer belongs in the route.
4. Set each view's duration. This is the travel time **from that view to the
   next**; the last view's duration is a hold at the end. New views use three
   seconds. A route supports up to 32 views and two minutes in total.
5. Choose **Play**, then **Pause** when you need to inspect a frame. Play resumes
   a paused route. **Stop** returns to the camera position from before the
   preview or playback. A completed route remains on its final view until you
   stop it or move the camera yourself.

One saved view holds the camera in place. Add another view with different
framing or choose **Full orbit** to record camera movement.

Interacting outside the tour panel stops the tour. Manual camera navigation
keeps your new framing, including dragging, zooming and navigation controls.
The tour's animation loop runs only while playing; pausing or stopping it does
not leave a continuous camera animation running.

Movement eases between compatible views. The planner can include views on
floors that exist in the open project, with a cut when the floor changes.
Generated Home and Editor views each keep their own route for the current
floor; their routes cannot be mixed. Home uses a cut when the focused room
changes. Return from the map overview to the house before saving a Home view;
map navigation is not part of a tour. Opening another generated-viewer floor
ends that page's session.

The route controls the camera only. It does not move furniture, change the
drawing, or send Home Assistant service calls. It is not connected to security
camera entities or their live feeds.

## Keep your route

Routes are held **in this page session only**. Use **Export route** to save JSON
before reloading, closing the page or opening another generated-viewer floor.
Use **Import route** in the corresponding project/view to replay or edit it
again. Import replaces the current route, so export an existing route first
if you want to keep both.

Tour JSON contains names, timings, floor/room identifiers and camera poses. It
does not contain the home's geometry. Keep it with the corresponding drawing;
coordinates can frame the wrong place after geometry or floor heights change.
Planner, generated Home and generated Editor routes are scoped to their own
viewer type. Importing one into another viewer type does not convert its
coordinates or make it playable there.

Saving a planner project or publishing a home does not save this session's
route. Tour JSON is separate from inventory JSON, Home Assistant storage and
the GLB, OBJ, USDZ and DAE model downloads.

In Home Assistant, family access can create and play a route within the page
session. Route export and video recording require the host's existing download
permission; those controls are disabled when access does not allow downloads.
If that permission is removed, an active recording is discarded and its video
preview and download are removed. Camera playback remains available.

## Export a video

Preview the route first, then choose **Record video** to play it from the
beginning and capture a local video. Recording finishes at the end of the
route; **Stop recording** finishes an early take. The result appears under
**Recorded tour** in the same panel, with video controls and a **Download MP4**
link. It does not start playing or download automatically. Play it in the panel,
then choose the link when you want to save the file. Closing the panel or hiding
the page pauses and unloads the preview; reopening makes the same local result
available again without autoplay. A successful new recording replaces it.
Keep the page visible while recording. The browser records the rendered
3D canvas: HTML room labels, device buttons, menus and other interface overlays
are not included. The recorder does not capture the microphone, system audio
or the rest of your screen.

Home Studio records **MP4** using the browser's own encoder. **Download MP4**
saves `home-studio-tour.mp4`. Support depends on the browser, device and available
codec; a browser that can play MP4 may still be unable to record it. If MP4
recording is unavailable, the panel explains the limitation. You can still
create and play routes, and export their JSON when downloads are permitted.
There is no WebM fallback, local format converter or remote encoding service.

Recordings are bounded to two minutes and 64 MiB. The recorder stops when its
duration limit is reached, the page becomes hidden or the video track ends.
Capture or encoding errors, loss of the graphics context and recordings above
the size limit discard incomplete output. A camera-navigation error stops the
route and finishes the current recording when the encoder can still complete
it. Avoid changing the viewport size or switching pages during a take;
recording is a live capture and follows the browser's rendering performance.
Frame rate and smoothness are not guaranteed.

The file stays local until you choose to share it. You may upload it yourself
to a video editor or a video-generation service as a camera-motion reference,
if that service accepts the format. Camera tours have no provider connection,
automatic upload or AI-video generation step. An external service determines
how closely its output follows the reference.

## Implementation boundaries

The shared route engine in `camera-tour.js` validates a schema-1 document with
`waypoints`, each containing `id`, `name`, `duration` and `pose`. It owns the
play/pause/stop state, interpolation and temporary camera restoration. A
perspective pose records its floor, target, orbit angles and radius. A Home
pose records its floor, focused room, rotation, tilt, zoom and pan. Names are
limited to 80 characters, each duration is at least 0.25 seconds, and rejected
imports leave the existing route intact.

The orbit helper creates five ordinary waypoints with four 4.75-second legs
and a one-second final hold. The session seeds them once on creation, without
applying a pose or scheduling an animation frame. Orbit and custom routes use
the same validation, editing, playback and JSON format. Hosts can provide a
separate `captureOrbit` adapter for whole-house framing; ordinary capture still
supplies custom saved views and the original camera restored by Stop.

`camera-tour-panel.js` presents that engine; `camera-tour.css` styles its
controls. `camera-tour-session.js` connects playback, recording, inline video and downloads,
and caps camera updates at 24 frames per second. `camera-tour-recording.js`
owns canvas capture, format detection, the media stream and output limits.
Recording uses the canvas provided by its host, with no new renderer, remote
encoder or Home Assistant command path.

Each host loads the tools on demand and adapts its existing camera state.
`planner/camera-tour-adapter.js` connects the planner to callbacks that apply
poses to `orbit` in `planner/editor.js`. `camera-tour-viewer.js` creates the
separate generated Home and Editor sessions. Editor poses update the
radius/azimuth/polar/target state in `viewer.js`; Home owns its separate
orthographic navigation in `home-view.js`. Directly moving a Three.js camera
is insufficient because the next normal render rebuilds it from that state.
Camera ticks should request only the relevant 3D render and should reuse
geometry, materials and shadow maps.

Host cleanup stops playback and capture on page/view changes, graphics-context
loss and renderer disposal. A restored planner may replace its canvas, so
capture must resolve the current canvas when starting a new recording. Manual
navigation cancels the pending restoration before changing the camera.
The recorded player and download share one Blob URL. Hiding unloads the media
source; showing the panel restores it without autoplay. A successful replacement,
permission loss or session disposal removes the result and revokes its URL.

Generated HTML embeds the runtime through `planner/project.py`; it must also
embed the tour modules and styles so the viewer works offline. The public
site/editor inventory in `scripts/validate-site.py`, companion inventory in
`ai_companion/assets.json` and compiler runtime in
`scripts/build-home-studio.py` must contain the corresponding sources. Model
exporters in `exporters.py` and `physical_exports.py` remain concerned with
geometry and materials; they do not encode this browser recording.

For regression coverage, exercise the default full turn in the public planner
and both generated views, opening without movement, preserving edited or
cleared routes on reopen, pause/resume timing, Stop restoration,
manual-navigation cancellation, room/floor cuts, JSON round trips, and invalid
imports. Check that idle/paused/completed tours schedule no frames, camera
playback does not redraw the 2D plan, and hiding the page or losing the graphics
context releases capture resources. A real-browser recording check should
decode a short saved MP4 file and verify its actual container, MIME type, dimensions and nonzero
duration, in addition to testing unavailable MP4 support, mismatched formats
and capture failures.
