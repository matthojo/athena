// Replies recorded from the public chess APIs on 7 Nov 2026 (trimmed: no move lists, avatars or PGN).
// Lichess: GET lichess.org/api/user/thibault and /api/games/user/thibault (NDJSON, newest first).
// Chess.com: GET api.chess.com/pub/player/hikaru and its 2026/10 and 2026/11 archives (the last few games of each).
export const LICHESS_USER = { id: "thibault", username: "thibault", createdAt: 1290415680000, seenAt: 1794053661507 };
export const LICHESS_GAMES_NDJSON =
  '{"id":"h7BRAh6C","rated":true,"variant":"standard","speed":"blitz","perf":"blitz","createdAt":1793994443857,"lastMoveAt":1793994726583,"status":"resign","source":"pool","players":{"white":{"user":{"name":"thibault","id":"thibault"},"rating":1744,"ratingDiff":6},"black":{"user":{"name":"grandchecker","id":"grandchecker"},"rating":1710,"ratingDiff":-5}},"winner":"white","clock":{"initial":300,"increment":3,"totalTime":420}}\n{"id":"PE5PRUAJ","rated":true,"variant":"standard","speed":"bullet","perf":"bullet","createdAt":1793865094160,"lastMoveAt":1793865172701,"status":"mate","source":"pool","players":{"white":{"user":{"name":"Morteza6066","id":"morteza6066"},"rating":1806,"ratingDiff":-6},"black":{"user":{"name":"thibault","id":"thibault"},"rating":1774,"ratingDiff":33}},"winner":"black","clock":{"initial":60,"increment":0,"totalTime":60}}\n{"id":"k8OVq8Y5","rated":true,"variant":"standard","speed":"rapid","perf":"rapid","createdAt":1792691852790,"lastMoveAt":1792692761977,"status":"mate","source":"pool","players":{"white":{"user":{"name":"thibault","id":"thibault"},"rating":1823,"ratingDiff":13},"black":{"user":{"name":"ismael11008","id":"ismael11008"},"rating":1867,"ratingDiff":-6}},"winner":"white","clock":{"initial":600,"increment":0,"totalTime":600}}\n{"id":"aDN8u0zd","rated":true,"variant":"standard","speed":"rapid","perf":"rapid","createdAt":1792613869218,"lastMoveAt":1792614257022,"status":"timeout","source":"pool","players":{"white":{"user":{"name":"subziiro98","id":"subziiro98"},"rating":1805,"ratingDiff":-5},"black":{"user":{"name":"thibault","id":"thibault"},"rating":1811,"ratingDiff":12}},"winner":"black","clock":{"initial":600,"increment":0,"totalTime":600}}\n{"id":"QgBb1l8L","rated":true,"variant":"standard","speed":"rapid","perf":"rapid","createdAt":1792593046382,"lastMoveAt":1792593356868,"status":"resign","source":"pool","players":{"white":{"user":{"name":"thibault","id":"thibault"},"rating":1798,"ratingDiff":13},"black":{"user":{"name":"C4C5LOOOOOSERRRS","id":"c4c5loooooserrrs"},"rating":1813,"ratingDiff":-6}},"winner":"white","clock":{"initial":600,"increment":0,"totalTime":600}}\n{"id":"fPQMtU5T","rated":true,"variant":"standard","speed":"rapid","perf":"rapid","createdAt":1792522476903,"lastMoveAt":1792522923231,"status":"resign","source":"pool","players":{"white":{"user":{"name":"Shakahola001","id":"shakahola001"},"rating":1695,"ratingDiff":-4},"black":{"user":{"name":"thibault","id":"thibault"},"rating":1787,"ratingDiff":11}},"winner":"black","clock":{"initial":600,"increment":0,"totalTime":600}}\n';
export const CHESSCOM_PLAYER = {
  "@id": "https://api.chess.com/pub/player/hikaru",
  url: "https://www.chess.com/member/Hikaru",
  username: "hikaru",
  player_id: 15448422,
  status: "premium",
  joined: 1389043258,
  last_online: 1793989501,
};
export const CHESSCOM_ARCHIVES = {
  archives: ["https://api.chess.com/pub/player/hikaru/games/2026/09", "https://api.chess.com/pub/player/hikaru/games/2026/10", "https://api.chess.com/pub/player/hikaru/games/2026/11"],
};
export const CHESSCOM_2026_10 = {
  games: [
    {
      url: "https://www.chess.com/game/live/186299458406",
      time_control: "180",
      end_time: 1793474961,
      rated: true,
      time_class: "blitz",
      rules: "chess",
      white: { rating: 3443, result: "resigned", username: "Hikaru" },
      black: { rating: 3309, result: "win", username: "Sina-Movahed" },
    },
    {
      url: "https://www.chess.com/game/live/186299623076",
      time_control: "180",
      end_time: 1793475174,
      rated: true,
      time_class: "blitz",
      rules: "chess",
      white: { rating: 3304, result: "resigned", username: "Sina-Movahed" },
      black: { rating: 3448, result: "win", username: "Hikaru" },
    },
    {
      url: "https://www.chess.com/game/live/186299800014",
      time_control: "180",
      end_time: 1793475560,
      rated: true,
      time_class: "blitz",
      rules: "chess",
      white: { rating: 3453, result: "win", username: "Hikaru" },
      black: { rating: 3299, result: "timeout", username: "Sina-Movahed" },
    },
  ],
};
export const CHESSCOM_2026_11 = {
  games: [
    {
      url: "https://www.chess.com/game/live/186671064216",
      time_control: "180",
      end_time: 1793989929,
      rated: true,
      time_class: "blitz",
      rules: "chess",
      white: { rating: 3074, result: "resigned", username: "only_strong_moves" },
      black: { rating: 3457, result: "win", username: "Hikaru" },
    },
    {
      url: "https://www.chess.com/game/live/186671326662",
      time_control: "180",
      end_time: 1793990090,
      rated: true,
      time_class: "blitz",
      rules: "chess",
      white: { rating: 3459, result: "win", username: "Hikaru" },
      black: { rating: 3072, result: "resigned", username: "only_strong_moves" },
    },
    {
      url: "https://www.chess.com/game/live/186671484330",
      time_control: "180",
      end_time: 1793990361,
      rated: true,
      time_class: "blitz",
      rules: "chess",
      white: { rating: 3070, result: "resigned", username: "only_strong_moves" },
      black: { rating: 3461, result: "win", username: "Hikaru" },
    },
    {
      url: "https://www.chess.com/game/live/186671751184",
      time_control: "180",
      end_time: 1793990614,
      rated: true,
      time_class: "blitz",
      rules: "chess",
      white: { rating: 3463, result: "win", username: "Hikaru" },
      black: { rating: 3068, result: "resigned", username: "only_strong_moves" },
    },
    {
      url: "https://www.chess.com/game/live/186672000482",
      time_control: "180",
      end_time: 1793990890,
      rated: true,
      time_class: "blitz",
      rules: "chess",
      white: { rating: 3066, result: "resigned", username: "only_strong_moves" },
      black: { rating: 3465, result: "win", username: "Hikaru" },
    },
  ],
};
