# Controls enhancement plan

Version 1.6.0 delivers these optional modules around the existing playback engines:

1. Configurable toolbar and center-button order; compact settings groups and accessible labels.
2. Subtitle appearance preferences with reset, preserving source layout by default and distinguishing text from bitmap captions.
3. Playback speed for VOD, without competing with live latency control.
4. Application-defined or native chapter lists and an application-owned playback queue.
5. Native remote playback/AirPlay and an explicit Google Cast sender adapter using receiver-accessible media URLs.
6. Frame download/copy for unprotected video with browser capability and CORS checks.

Verification covers lifecycle/reset, queue errors and navigation, chapter boundaries, rate restrictions, subtitle style reset, remote API contracts, frame extraction and keyboard/mobile UI behavior. Physical AirPlay/Cast devices and DRM receiver integrations require separate deployment-specific validation. Each module will have documented defaults, a working integration example and explicit limitations.

Implementation: the modules and integrator guide are delivered in 1.6.0. See [Controls integration](controls-integration.md) for APIs and acceptance boundaries, including physical remote devices and provider-specific receivers.
