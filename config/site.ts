/** What the public product page (served at "/") says about the service. */
export const SITE = {
  name: "通事",
  tagline: "LINE 群組翻譯協調助手",
  /** One letter for the logo and the bot's avatar in the sample chat. */
  mark: "通",
  /** Where the name comes from, shown under the hero. */
  story: "「通事」是清代在不同語言的族群之間翻譯、協調的人。今天，它住在你的 LINE 群組裡。",
  /** The official account people add to ask about plans; also the bot they invite. */
  lineId: "@021eubwk",
  /** Shown as the white-label price. */
  enterprisePrice: "專案報價",
};

export const addFriendUrl = (lineId: string) => `https://line.me/R/ti/p/${encodeURIComponent(lineId)}`;
