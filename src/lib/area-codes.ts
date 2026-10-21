// US area code -> state, used only to guess a calling timezone when a lead has
// no state or ZIP. Cell numbers move with people, so this is approximate.
const BY_STATE: Record<string, number[]> = {
  AL: [205, 251, 256, 334, 659, 938],
  AK: [907],
  AZ: [480, 520, 602, 623, 928],
  AR: [327, 479, 501, 870],
  CA: [209, 213, 279, 310, 323, 341, 350, 369, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951],
  CO: [303, 719, 720, 970, 983],
  CT: [203, 475, 860, 959],
  DE: [302],
  DC: [202, 771],
  FL: [239, 305, 321, 324, 352, 386, 407, 448, 561, 645, 656, 689, 727, 728, 754, 772, 786, 813, 850, 863, 904, 941, 954],
  GA: [229, 404, 470, 478, 678, 706, 762, 770, 912, 943],
  HI: [808],
  ID: [208, 986],
  IL: [217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 861, 872],
  IN: [219, 260, 317, 463, 574, 765, 812, 930],
  IA: [319, 515, 563, 641, 712],
  KS: [316, 620, 785, 913],
  KY: [270, 364, 502, 606, 859],
  LA: [225, 318, 337, 504, 985],
  ME: [207],
  MD: [227, 240, 301, 410, 443, 667],
  MA: [339, 351, 413, 508, 617, 774, 781, 857, 978],
  MI: [231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 906, 947, 989],
  MN: [218, 320, 507, 612, 651, 763, 924, 952],
  MS: [228, 601, 662, 769],
  MO: [235, 314, 417, 557, 573, 636, 660, 816, 975],
  MT: [406],
  NE: [308, 402, 531],
  NV: [702, 725, 775],
  NH: [603],
  NJ: [201, 551, 609, 640, 732, 848, 856, 862, 908, 973],
  NM: [505, 575],
  NY: [212, 315, 329, 332, 347, 363, 516, 518, 585, 607, 624, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934],
  NC: [252, 336, 472, 704, 743, 828, 910, 919, 980, 984],
  ND: [701],
  OH: [216, 220, 234, 283, 326, 330, 380, 419, 436, 440, 513, 567, 614, 740, 937],
  OK: [405, 539, 572, 580, 918],
  OR: [458, 503, 541, 971],
  PA: [215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717, 724, 814, 835, 878],
  RI: [401],
  SC: [803, 821, 839, 843, 854, 864],
  SD: [605],
  TN: [423, 615, 629, 731, 865, 901, 931],
  TX: [210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 915, 936, 940, 945, 956, 972, 979],
  UT: [385, 435, 801],
  VT: [802],
  VA: [276, 434, 540, 571, 686, 703, 757, 804, 826, 948],
  WA: [206, 253, 360, 425, 509, 564],
  WV: [304, 681],
  WI: [262, 274, 353, 414, 534, 608, 715, 920],
  WY: [307],
};

// Area codes whose zone differs from their state's main zone.
const ZONE_OVERRIDE: Record<number, string> = {
  850: "America/Chicago", // Florida panhandle (partly Eastern)
  915: "America/Denver", // El Paso
  208: "America/Boise",
  906: "America/Detroit",
  423: "America/New_York", // Chattanooga / east Tennessee
  865: "America/New_York", // Knoxville
  270: "America/Chicago", // western Kentucky
  364: "America/Chicago",
  219: "America/Chicago", // northwest Indiana
};

// Canadian area codes share +1, so applicants from Canada would otherwise get no timezone.
const CANADA: Record<string, number[]> = {
  "America/Vancouver": [236, 250, 257, 604, 672, 778],
  "America/Edmonton": [368, 403, 587, 780, 825],
  "America/Regina": [306, 474, 639],
  "America/Winnipeg": [204, 431, 584],
  "America/Toronto": [226, 249, 263, 289, 343, 354, 365, 367, 382, 416, 418, 437, 438, 450, 468, 514, 519, 548, 579, 581, 613, 647, 683, 705, 742, 753, 807, 819, 873, 905],
  "America/Moncton": [428, 506],
  "America/Halifax": [782, 902],
  "America/St_Johns": [709, 879],
};
for (const [tz, codes] of Object.entries(CANADA)) for (const c of codes) ZONE_OVERRIDE[c] = tz;

const STATE_BY_CODE = new Map<number, string>();
for (const [st, codes] of Object.entries(BY_STATE)) for (const c of codes) STATE_BY_CODE.set(c, st);

export function areaCodeOf(phoneE164: string): number | null {
  const m = phoneE164.match(/^\+1(\d{3})\d{7}$/);
  return m ? Number(m[1]) : null;
}

export function stateFromPhone(phoneE164: string): string | null {
  const c = areaCodeOf(phoneE164);
  return c ? STATE_BY_CODE.get(c) ?? null : null;
}

/** Best-guess timezone from the area code, given the state's main zone. */
export function timezoneFromPhone(phoneE164: string, stateMainZone: (state: string) => string | null): string | null {
  const c = areaCodeOf(phoneE164);
  if (!c) return null;
  if (ZONE_OVERRIDE[c]) return ZONE_OVERRIDE[c];
  const st = STATE_BY_CODE.get(c);
  return st ? stateMainZone(st) : null;
}
