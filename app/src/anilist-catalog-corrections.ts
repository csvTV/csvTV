export interface AniListCorrection {
  showId: number;
  publishedSeason: number;
  publishedOffset: number | null;
  segments: {from: number; season: number; ids: readonly number[]}[];
}

// These entries currently have no TV ID in the published catalog. Check the linked
// series' own catalog row before using its identity. A sequel without an episode
// mapping can contribute status and ratings but cannot borrow the parent’s watches.
export const verifiedAniListSeries = new Map<number, {related: number; showId: number; format: string; season: number | null}>([
  [20811,  {related:16498, showId:1429, format:'OVA', season:0}],
  [139754, {related:16498, showId:1429, format:'Special', season:0}],
  [181951, {related:145728, showId:229676, format:'TV series', season:null}],
  [209670, {related:187264, showId:285166, format:'TV series', season:null}],
  [212563, {related:183661, showId:284495, format:'Special', season:0}],
]);

// Stable TMDB episode IDs for public broadcast runs that cross the catalog's season boundaries.
export const aniListCorrections = new Map<number, AniListCorrection>([
  [4382, {showId:42511, publishedSeason:1, publishedOffset:0, segments:[{from:1,season:1,ids:[
    880922,880925,880930,880928,880931,880932,880927,1522926,880934,880933,880924,1522928,
    1522929,1522930,1522931,1522932,1522933,1522935,1522937,1522940,1522943,1522944,
    1522946,1522949,880923,880935,880929,880926,
  ]}]}],
  [6007, {showId:26707, publishedSeason:0, publishedOffset:null, segments:[{from:1,season:0,ids:[674653]}]}],
  [18397, {showId:1429, publishedSeason:0, publishedOffset:null, segments:[{from:1,season:0,ids:[65498,1029391,1029392]}]}],
  [20811, {showId:1429, publishedSeason:0, publishedOffset:null, segments:[{from:1,season:0,ids:[1029395,1029396]}]}],
  [21039, {showId:61663, publishedSeason:0, publishedOffset:null, segments:[{from:1,season:0,ids:[1190184]}]}],
  [100523, {showId:70878, publishedSeason:0, publishedOffset:null, segments:[{from:1,season:0,ids:[1675197,1675708]}]}],
  [139754, {showId:1429, publishedSeason:0, publishedOffset:null, segments:[{from:1,season:0,ids:[3742890,3742891]}]}],
  [212563, {showId:284495, publishedSeason:0, publishedOffset:null, segments:[{from:1,season:0,ids:[7319588]}]}],
  [2167, {showId:24835, publishedSeason:1, publishedOffset:0, segments:[
    {from:1, season:1, ids:[
      647098, 647099, 647100, 647101, 647102, 647103, 647104, 647105, 647106,
      647107, 647108, 647109, 647110, 647111, 647112, 647113, 647114, 647115,
      647116, 647117, 647118, 647119,
    ]},
    {from:23, season:0, ids:[2006508]},
  ]}],
  [2966, {showId:26707, publishedSeason:1, publishedOffset:0, segments:[
    {from:1, season:1, ids:[674626, 674627, 674628, 674629, 674630, 674631]},
    {from:7, season:0, ids:[674650]},
    {from:8, season:1, ids:[674633, 674634, 674635, 674636, 674637, 1218935]},
  ]}],
  [4181, {showId:24835, publishedSeason:2, publishedOffset:0, segments:[
    {from:1, season:2, ids:[
      647121, 647122, 647123, 647124, 647125, 647126, 647127, 647128, 647129,
      647130, 647131, 647132, 647133, 647134, 647135, 647136, 647137, 647138,
      647139, 647140, 647141, 647142,
    ]},
    {from:23, season:0, ids:[2006521, 2006522]},
  ]}],
  [11741, {showId:45845, publishedSeason:1, publishedOffset:13, segments:[
    {from:1, season:2, ids:[
      1061698, 1061699, 1061700, 1061701, 1061702, 1061703, 1061704, 1061705, 1061706,
      1061707, 1061708, 1061709,
    ]},
  ]}],
  [108632, {showId:65942, publishedSeason:1, publishedOffset:26, segments:[
    {from:1, season:1, ids:[
      4319552, 4319553, 4319554, 4319555, 4319556, 4319557, 4319558, 4319559, 4319560,
      4319561, 4319562, 4319563, 4319564,
    ]},
  ]}],
  [145064, {showId:95479, publishedSeason:2, publishedOffset:0, segments:[
    {from:1, season:1, ids:[
      4562708, 4562709, 4562710, 4562711, 4562712, 4562713, 4562714, 4562715, 4562716,
      4562717, 4562718, 4562719, 4562720, 4562721, 4562722, 4562723, 4562725, 4562726,
      4562727, 4562728, 4562729, 4562730, 4562731,
    ]},
  ]}],
  [146065, {showId:94664, publishedSeason:2, publishedOffset:0, segments:[
    {from:1, season:0, ids:[4556476]},
    {from:2, season:2, ids:[
      4472785, 4556433, 4573329, 4573330, 4573332, 4573334, 4573335, 4573337, 4573339,
      4573341, 4573344, 4573390,
    ]},
  ]}],
  [163329, {showId:105009, publishedSeason:1, publishedOffset:36, segments:[
    {from:1, season:1, ids:[
      4709761, 4786124, 4787124, 4787127, 4787128, 4787129, 4787130, 4787131, 4787133,
      4787134, 4787135, 4787137, 4787138,
    ]},
  ]}],
  [176496, {showId:127532, publishedSeason:2, publishedOffset:0, segments:[
    {from:1, season:1, ids:[
      5876034, 5876038, 5891808, 5891809, 5891811, 5891813, 5891814, 5891815, 5891816,
      5891817, 5891818, 5891819, 5891820,
    ]},
  ]}],
]);
