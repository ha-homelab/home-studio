# Home Studio documentation index

This index covers the public Home Studio source: the in-Home-Assistant drawing and
publishing workflow, the optional portable editor and compiler, rendering
references, and the browser and release evidence behind them. If you only want to
draw a first room, start with the [wiki getting-started page](wiki/Getting-started.md).

## Get started

- [Wiki home](wiki/Home.md): the maintained, repository-local wiki.
- [Install Home Studio and draw in Home Assistant](wiki/Getting-started.md).
- [Install, draw and publish inside Home Assistant](home-assistant-editor.md):
  the long-form version, including migration from older generated homes.
- [Your first home, without a blank-page problem](first-session.md).
- [Website experience and operating guide](site-experience.md): the public
  overview and help pages.
- [Languages](wiki/Languages.md) and [localized quick starts](translations/README.md).
  The 23 translated quick starts beside that index (`README.ar.md` through
  `README.zh-Hant.md`) cover the same install path in each language.
- [Wiki sidebar](wiki/_Sidebar.md): the compact navigation for the local wiki.

## Draw and furnish

- [Draw your home and its surroundings](site-editor.md): the Site & roof mode.
- [Drawings and materials](drawing-package.md).
- [Curtains in Home Studio](curtain-authoring.md).
- [Stock catalog geometry and physical surfaces](catalog-material-authoring.md).
- [Optional reviewed material textures](material-textures.md).
- [Calibrate an imported home's site frame](imported-site-calibration.md).
- [Garden surroundings](environment.md) and [decorative surroundings](site-experience.md).
- [Camera tours and local video](camera-tours.md).
- [Geographic map navigation](map-navigation.md).
- [From Home Assistant to Blender](blender-export.md).

## Connect your devices

- [Make the plan useful for your devices](device-controls.md).
- [Try device controls without operating them](dry-run.md) and the
  [dry-run process, results and evidence](process-and-results.md).
- [Wiki: dry run](wiki/Dry-run.md) for the short operational version.
- [Optional appliance and presence indicators](indicators.md).
- [Vacuum position overlays](vacuum-position.md).
- [Put your home on a dashboard, with media artwork](dashboard-and-media.md).
- [Rounded wall rendering and acceptance](rounded-walls.md): the inflated wall
  cross-section, its resource limits and the recorded checks.

## Optional AI drafting

- [From photos to an editable plan](ai-planning.md).
- [AI provider setup](ai-provider-setup.md) and [local AI models](ai-local-models.md).
- [AI-assisted planner architecture](ai-planner-architecture.md): the two
  transports, shared panel and draft validator.

## Reference

- [Architecture: shared code and private homes](architecture.md).
- [Point attenuation with a constant decay](point-decay-two.md) and
  [scoped scalar Lambert lighting](literal-lambert-directional.md): packed
  renderer specializations.
- [Transport security profiles](transport-security.md).

## Development

- [Wiki: development and validation](wiki/Development.md).
- [Cross-platform acceptance](platform-acceptance.md).
- [Browser compatibility and rendering acceptance](browser-compatibility.md).
- [How Home Studio is tested and released](quality-and-release.md).
- [Languages and translation contributions](i18n.md).
- [Closed HA packages in public release orchestration](closed-build.md),
  [closed builds in the public release workflow](closed-builds.md) and the
  [closed release bootstrap contract](closed-release-bootstrap.md): the optional
  private-build route, currently disabled in `.release-policy.json`.

## Evidence

- [Quality evidence and limitations](quality.md).
- [Wiki: troubleshooting](wiki/Troubleshooting.md).

Shared repository policy (`release-workflow.md`, `quality.md`, `fuzzing.md`,
`rc-fuzzing.md`, `runner-preflight.md`, `release-read-safety.md`,
`release-github-cli.md`, `VERSIONING.md`) comes from the shared release toolkit;
those files are maintained centrally and are not repeated here.

Dated acceptance numbers and screenshots belong to the release that produced
them. They are not a live status report for your installation.
