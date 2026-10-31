/**
 * The logo (from the 通事 avatar), served by the Worker at these paths and
 * used by every page: header logo, browser tab icon, home-screen icon.
 */
export const LOGO_PATH = "/logo.png";
export const FAVICON_PATH = "/favicon-32.png";
export const TOUCH_ICON_PATH = "/apple-touch-icon.png";

/** <head> lines for the tab and home-screen icons. */
export const iconLinks = () =>
  `<link rel="icon" type="image/png" sizes="32x32" href="${FAVICON_PATH}">\n<link rel="apple-touch-icon" href="${TOUCH_ICON_PATH}">`;
