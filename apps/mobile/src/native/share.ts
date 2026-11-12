// The playpex-device module's Share to Playpex (Kotlin: ACTION_SEND text/plain, app.json's intent
// filter; sharing shortcuts per screen, plugins/with-share-targets.js), for state/share.tsx
// (docs/cast-plan.md §5)
export { onShare, setShareTargets, takeShared, type Shared } from '../../modules/playpex-device'
