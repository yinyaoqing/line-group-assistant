/** What the public product page (served at "/") says about the service. */
export const SITE = {
  name: "工班通",
  tagline: "LINE 群組助理",
  /** The official account people add to ask about plans; also the bot they invite. */
  lineId: "@021eubwk",
  /** Shown as the white-label price. */
  enterprisePrice: "專案報價",
};

export const addFriendUrl = (lineId: string) => `https://line.me/R/ti/p/${encodeURIComponent(lineId)}`;
