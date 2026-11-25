// The phone stylesheets. They are loaded as one lazy chunk by `bootstrap.ts` before the first
// phone paint, and by `applyPhoneClass()` when a resize first switches a host into the phone
// layout. Desktop, tablet, Harmony and old-shell clients therefore never ship or parse them in
// their main CSS. Add every phone-only stylesheet here; keep shared desktop rules out.
import './mobile.css'
import './menu-phone.css'
import './phone-shop.css'
import './phone-games.css'
import '../css/phone-pages.css'
import '../css/phone-panels.css'

/** Marker for build checks: this module exists only for its stylesheet side effects. */
export const phoneCssLoaded = true
