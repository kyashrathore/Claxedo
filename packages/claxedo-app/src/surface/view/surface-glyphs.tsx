import type { JSX } from "solid-js"
import type { GlyphIconName } from "../icon-names"

const BELL = "M5 8.33a5 5 0 0 1 10 0c0 4.17 1.67 5.84 1.67 5.84H3.33S5 12.5 5 8.33zM8.33 16.67a1.67 1.67 0 0 0 3.34 0"
const CALENDAR = "M2.92 7.92h14.16M6.67 2.08v3.34M13.33 2.08v3.34"
const EYE = "M10 4.58C5.83 4.58 2.5 10 2.5 10s3.33 5.42 7.5 5.42S17.5 10 17.5 10 14.17 4.58 10 4.58z"
const HEART = "M10 16.67s-6.67-3.92-6.67-8.75A3.75 3.75 0 0 1 10 5.42a3.75 3.75 0 0 1 6.67 2.5c0 4.83-6.67 8.75-6.67 8.75z"
const STAR = "M10 2.5l2.2 4.7 5.1.5-3.8 3.4 1.1 5.1-4.6-2.6-4.6 2.6 1.1-5.1-3.8-3.4 5.1-.5z"
const SLASH = "M3.33 3.33l13.34 13.34"

function Calendar(props: { readonly children?: JSX.Element }) {
  return (
    <>
      <rect x="2.92" y="3.75" width="14.17" height="13.33" rx="1" />
      <path d={CALENDAR} />
      {props.children}
    </>
  )
}

function Lock(props: { readonly shackle: string }) {
  return (
    <>
      <rect x="3.75" y="8.75" width="12.5" height="8.75" rx="1" />
      <path d={props.shackle} />
    </>
  )
}

export const SURFACE_GLYPHS: Readonly<Record<GlyphIconName, () => JSX.Element>> = {
  accountCircle: () => (
    <>
      <circle cx="10" cy="10" r="7.92" />
      <circle cx="10" cy="8.33" r="2.5" />
      <path d="M5.2 15.6c.95-1.9 2.7-3.1 4.8-3.1s3.85 1.2 4.8 3.1" />
    </>
  ),
  calendarToday: () => (
    <Calendar>
      <rect x="6.25" y="10.42" width="2.5" height="2.5" fill="currentColor" stroke="none" />
    </Calendar>
  ),
  event: () => (
    <Calendar>
      <path d="M7.5 12.5l1.67 1.67 3.33-3.34" />
    </Calendar>
  ),
  favorite: () => <path d={HEART} fill="currentColor" />,
  favoriteOff: () => <path d={HEART} />,
  home: () => <path d="M2.92 8.75L10 2.92l7.08 5.83M4.58 7.5v9.58h10.84V7.5M8.33 17.08v-5h3.34v5" />,
  info: () => (
    <>
      <circle cx="10" cy="10" r="7.92" />
      <path d="M10 9.17v5" />
      <circle cx="10" cy="6.46" r=".63" fill="currentColor" stroke="none" />
    </>
  ),
  locationOn: () => (
    <>
      <path d="M10 17.92s-5.42-4.9-5.42-9.17a5.42 5.42 0 0 1 10.84 0c0 4.27-5.42 9.17-5.42 9.17z" />
      <circle cx="10" cy="8.75" r="2.08" />
    </>
  ),
  lock: () => <Lock shackle="M6.25 8.75V6.25a3.75 3.75 0 0 1 7.5 0v2.5" />,
  lockOpen: () => <Lock shackle="M6.25 8.75V6.25a3.75 3.75 0 0 1 7.33-1.12" />,
  mail: () => (
    <>
      <rect x="2.5" y="4.17" width="15" height="11.67" rx="1" />
      <path d="M2.92 4.79L10 10.83l7.08-6.04" />
    </>
  ),
  moreVert: () => (
    <>
      <circle cx="10" cy="4.58" r="1.04" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.04" fill="currentColor" stroke="none" />
      <circle cx="10" cy="15.42" r="1.04" fill="currentColor" stroke="none" />
    </>
  ),
  notifications: () => <path d={BELL} />,
  notificationsOff: () => <path d={`${BELL}${SLASH}`} />,
  pause: () => (
    <>
      <rect x="5.83" y="4.17" width="2.5" height="11.67" rx=".5" />
      <rect x="11.67" y="4.17" width="2.5" height="11.67" rx=".5" />
    </>
  ),
  payment: () => (
    <>
      <rect x="2.5" y="4.58" width="15" height="10.84" rx="1" />
      <path d="M2.5 8.33h15M5.42 12.5h2.5" />
    </>
  ),
  person: () => (
    <>
      <circle cx="10" cy="6.5" r="3" />
      <path d="M3.75 17.08c.6-3.2 3.2-5.33 6.25-5.33s5.65 2.13 6.25 5.33" />
    </>
  ),
  play: () => <path d="M6.25 4.17v11.66L15.42 10z" />,
  shoppingCart: () => (
    <>
      <path d="M2.08 3.33h2.09l1.66 9.17h9.59l1.66-6.67H5" />
      <circle cx="7.08" cy="15.83" r="1.25" />
      <circle cx="14.17" cy="15.83" r="1.25" />
    </>
  ),
  skipNext: () => <path d="M4.58 4.17v11.66L12.5 10zM15.42 4.17v11.66" />,
  skipPrevious: () => <path d="M15.42 4.17v11.66L7.5 10zM4.58 4.17v11.66" />,
  star: () => <path d={STAR} fill="currentColor" />,
  starOff: () => <path d={STAR} />,
  visibilityOff: () => (
    <>
      <path d={EYE} />
      <circle cx="10" cy="10" r="2.5" />
      <path d={SLASH} />
    </>
  ),
}
