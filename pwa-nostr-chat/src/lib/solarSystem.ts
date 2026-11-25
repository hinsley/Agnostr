import { computeSublunarPoint, computeSubsolarPoint, latLonToUnitVec3 } from './astronomy.ts'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const TWO_PI = Math.PI * 2

export type Vec3Tuple = [number, number, number]

export type CelestialBodyKind = 'star' | 'planet' | 'moon'

export type CelestialBodyId =
  | 'sun'
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'moon'
  | 'mars'
  | 'phobos'
  | 'deimos'
  | 'jupiter'
  | 'io'
  | 'europa'
  | 'ganymede'
  | 'callisto'
  | 'saturn'
  | 'enceladus'
  | 'rhea'
  | 'titan'
  | 'uranus'
  | 'titania'
  | 'oberon'
  | 'neptune'
  | 'triton'
  | 'pluto'
  | 'charon'

export type GeohashableBodyId = Exclude<CelestialBodyId, 'sun'>

export type PlanetBodyId =
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune'
  | 'pluto'

export interface CelestialLandmark {
  readonly name: string
  readonly lat: number
  readonly lon: number
}

export interface CelestialBodyPalette {
  readonly primary: string
  readonly secondary: string
  readonly detail: string
  readonly accent: string
  readonly atmosphere?: string
  readonly orbitColor: string
}

export interface CelestialRingDef {
  readonly innerRadius: number
  readonly outerRadius: number
  readonly tiltDeg: number
  readonly color: string
  readonly opacity: number
}

export interface CelestialBodyDef {
  readonly id: CelestialBodyId
  readonly name: string
  readonly kind: CelestialBodyKind
  readonly parentId: CelestialBodyId | null
  readonly realRadiusKm: number
  readonly visualRadius: number
  readonly visualOrbitRadius: number
  readonly palette: CelestialBodyPalette
  readonly rings?: CelestialRingDef
  readonly axialTiltDeg: number
  readonly rotationPeriodHours: number
  readonly landmarks: readonly CelestialLandmark[]
}

export interface SolarBodySnapshot {
  readonly id: CelestialBodyId
  readonly position: Vec3Tuple
  readonly renderRadius: number
  readonly sunDir: Vec3Tuple
  /** Surface-local axes in the view frame; omitted when already aligned. */
  readonly surfaceAxes?: Mat3
  readonly distanceAuFromSun: number
  readonly isFocused: boolean
  readonly isSiblingMoon: boolean
  readonly isParentOfFocused: boolean
  readonly isChildMoonOfFocused: boolean
}

export interface SolarSystemSnapshot {
  readonly focusedBodyId: GeohashableBodyId
  readonly sunPos: Vec3Tuple
  readonly focusedSunDir: Vec3Tuple
  /** Rotation from Earth-fixed axes into the focused view, or null for no rotation. */
  readonly earthToViewAxes: Mat3 | null
  readonly bodies: Record<CelestialBodyId, SolarBodySnapshot>
}

export const SOLAR_BODY_IDS: readonly CelestialBodyId[] = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'phobos',
  'deimos',
  'jupiter',
  'io',
  'europa',
  'ganymede',
  'callisto',
  'saturn',
  'enceladus',
  'rhea',
  'titan',
  'uranus',
  'titania',
  'oberon',
  'neptune',
  'triton',
  'pluto',
  'charon',
] as const

export const PLANET_BODY_IDS: readonly PlanetBodyId[] = [
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
] as const

export const GEOHASHABLE_BODY_IDS: readonly GeohashableBodyId[] = SOLAR_BODY_IDS.filter(
  (id): id is GeohashableBodyId => id !== 'sun'
)

export const SOLAR_BODIES: Record<CelestialBodyId, CelestialBodyDef> = {
  sun: {
    id: 'sun',
    name: 'Sun',
    kind: 'star',
    parentId: null,
    realRadiusKm: 696340,
    visualRadius: 5.2,
    visualOrbitRadius: 0,
    palette: {
      primary: '#FFF4C8',
      secondary: '#FDBA3B',
      detail: '#F97316',
      accent: '#FEF08A',
      atmosphere: '#F59E0B',
      orbitColor: '#F59E0B',
    },
    axialTiltDeg: 7.25,
    rotationPeriodHours: 609.12,
    landmarks: [],
  },
  mercury: {
    id: 'mercury',
    name: 'Mercury',
    kind: 'planet',
    parentId: 'sun',
    realRadiusKm: 2439.7,
    visualRadius: 0.52,
    visualOrbitRadius: 17,
    palette: {
      primary: '#9A958E',
      secondary: '#6E6962',
      detail: '#C2BDB4',
      accent: '#B8A898',
      orbitColor: '#A8A29E',
    },
    axialTiltDeg: 0.034,
    rotationPeriodHours: 1407.6,
    landmarks: [
      { name: 'Caloris Basin', lat: 30.5, lon: -170.2 },
      { name: 'Rembrandt', lat: -32.9, lon: 87.9 },
      { name: 'Rachmaninoff', lat: 27.6, lon: 57.4 },
      { name: 'Borealis Planitia', lat: 73.4, lon: -79.5 },
      { name: 'Beethoven', lat: -20.8, lon: -123.6 },
    ],
  },
  venus: {
    id: 'venus',
    name: 'Venus',
    kind: 'planet',
    parentId: 'sun',
    realRadiusKm: 6051.8,
    visualRadius: 0.94,
    visualOrbitRadius: 26,
    palette: {
      primary: '#E5C687',
      secondary: '#C4954F',
      detail: '#F5E1B0',
      accent: '#D9A758',
      atmosphere: '#F3D28B',
      orbitColor: '#EAB308',
    },
    axialTiltDeg: 177.36,
    rotationPeriodHours: -5832.5,
    landmarks: [
      { name: 'Maxwell Montes', lat: 65.2, lon: 3.3 },
      { name: 'Aphrodite Terra', lat: -5.8, lon: 104.8 },
      { name: 'Ishtar Terra', lat: 70.4, lon: 27.5 },
      { name: 'Maat Mons', lat: 0.5, lon: -165.4 },
      { name: 'Mead Crater', lat: 12.5, lon: 57.2 },
    ],
  },
  earth: {
    id: 'earth',
    name: 'Earth',
    kind: 'planet',
    parentId: 'sun',
    realRadiusKm: 6371.0,
    visualRadius: 1.0,
    visualOrbitRadius: 38,
    palette: {
      primary: '#2563EB',
      secondary: '#2E7D32',
      detail: '#E2E8F0',
      accent: '#38BDF8',
      atmosphere: '#60A5FA',
      orbitColor: '#38BDF8',
    },
    axialTiltDeg: 23.439,
    rotationPeriodHours: 23.9345,
    landmarks: [],
  },
  moon: {
    id: 'moon',
    name: 'Moon',
    kind: 'moon',
    parentId: 'earth',
    realRadiusKm: 1737.4,
    visualRadius: 0.16,
    visualOrbitRadius: 4.2,
    palette: {
      primary: '#C4C6CA',
      secondary: '#7D818A',
      detail: '#E3E5E8',
      accent: '#9CA3AF',
      orbitColor: '#CBD5E1',
    },
    axialTiltDeg: 6.68,
    rotationPeriodHours: 655.728,
    landmarks: [
      { name: 'Sea of Tranquility', lat: 0.67, lon: 23.47 },
      { name: 'Tycho Crater', lat: -43.31, lon: -11.36 },
      { name: 'Copernicus', lat: 9.62, lon: -20.08 },
      { name: 'Oceanus Procellarum', lat: 18.4, lon: -57.4 },
      { name: 'South Pole-Aitken', lat: -53.0, lon: -169.0 },
    ],
  },
  mars: {
    id: 'mars',
    name: 'Mars',
    kind: 'planet',
    parentId: 'sun',
    realRadiusKm: 3389.5,
    visualRadius: 0.68,
    visualOrbitRadius: 51,
    palette: {
      primary: '#C8603B',
      secondary: '#8A3921',
      detail: '#E3A178',
      accent: '#F0B68A',
      atmosphere: '#E89068',
      orbitColor: '#EA580C',
    },
    axialTiltDeg: 25.19,
    rotationPeriodHours: 24.6229,
    landmarks: [
      { name: 'Olympus Mons', lat: 18.65, lon: -133.8 },
      { name: 'Valles Marineris', lat: -13.9, lon: -59.2 },
      { name: 'Jezero Crater', lat: 18.38, lon: 77.58 },
      { name: 'Gale Crater', lat: -5.4, lon: 137.8 },
      { name: 'Hellas Planitia', lat: -42.4, lon: 70.5 },
      { name: 'Elysium Mons', lat: 25.0, lon: 147.2 },
    ],
  },
  phobos: {
    id: 'phobos',
    name: 'Phobos',
    kind: 'moon',
    parentId: 'mars',
    realRadiusKm: 11.27,
    visualRadius: 0.11,
    visualOrbitRadius: 2.15,
    palette: {
      primary: '#8C7E75',
      secondary: '#5E534C',
      detail: '#B2A59B',
      accent: '#A69588',
      orbitColor: '#A8978D',
    },
    axialTiltDeg: 0.0,
    rotationPeriodHours: 7.6538,
    landmarks: [
      { name: 'Stickney Crater', lat: 1.0, lon: -49.0 },
      { name: 'Hall Crater', lat: -80.0, lon: 150.0 },
      { name: 'Roche Crater', lat: 53.0, lon: -177.0 },
      { name: 'Kepler Dorsum', lat: -45.0, lon: -4.0 },
    ],
  },
  deimos: {
    id: 'deimos',
    name: 'Deimos',
    kind: 'moon',
    parentId: 'mars',
    realRadiusKm: 6.2,
    visualRadius: 0.11,
    visualOrbitRadius: 3.25,
    palette: {
      primary: '#A4968A',
      secondary: '#74675D',
      detail: '#C9BCB0',
      accent: '#B8A89B',
      orbitColor: '#B5A69A',
    },
    axialTiltDeg: 0.0,
    rotationPeriodHours: 30.2986,
    landmarks: [
      { name: 'Swift Crater', lat: 12.5, lon: 1.8 },
      { name: 'Voltaire Crater', lat: 22.0, lon: -3.5 },
      { name: 'South Basin', lat: -65.0, lon: -40.0 },
      { name: 'North Ridge', lat: 55.0, lon: 120.0 },
    ],
  },
  jupiter: {
    id: 'jupiter',
    name: 'Jupiter',
    kind: 'planet',
    parentId: 'sun',
    realRadiusKm: 69911,
    visualRadius: 2.35,
    visualOrbitRadius: 72,
    palette: {
      primary: '#D8B48A',
      secondary: '#A76A45',
      detail: '#F2E0C8',
      accent: '#C85232',
      atmosphere: '#E5C49E',
      orbitColor: '#D97706',
    },
    axialTiltDeg: 3.13,
    rotationPeriodHours: 9.925,
    landmarks: [
      { name: 'Great Red Spot', lat: -22.0, lon: -45.0 },
      { name: 'North Equatorial Belt', lat: 12.0, lon: 40.0 },
      { name: 'South Polar Cyclones', lat: -82.0, lon: 15.0 },
      { name: 'Oval BA', lat: -33.0, lon: 85.0 },
      { name: 'North Polar Cyclones', lat: 84.0, lon: -110.0 },
    ],
  },
  io: {
    id: 'io',
    name: 'Io',
    kind: 'moon',
    parentId: 'jupiter',
    realRadiusKm: 1821.6,
    visualRadius: 0.16,
    visualOrbitRadius: 2.25,
    palette: {
      primary: '#E5CF58',
      secondary: '#B68627',
      detail: '#F5EE9E',
      accent: '#DC5326',
      orbitColor: '#EAB308',
    },
    axialTiltDeg: 0.05,
    rotationPeriodHours: 42.459,
    landmarks: [
      { name: 'Loki Patera', lat: 13.0, lon: -51.2 },
      { name: 'Pele', lat: -18.7, lon: 104.7 },
      { name: 'Prometheus', lat: -1.5, lon: -153.9 },
      { name: 'Tvashtar Paterae', lat: 62.8, lon: -123.5 },
      { name: 'Boosaule Montes', lat: -3.7, lon: 91.0 },
    ],
  },
  europa: {
    id: 'europa',
    name: 'Europa',
    kind: 'moon',
    parentId: 'jupiter',
    realRadiusKm: 1560.8,
    visualRadius: 0.15,
    visualOrbitRadius: 3.05,
    palette: {
      primary: '#DCD8CE',
      secondary: '#A57B5E',
      detail: '#F5F4F0',
      accent: '#93C5FD',
      orbitColor: '#BAE6FD',
    },
    axialTiltDeg: 0.1,
    rotationPeriodHours: 85.228,
    landmarks: [
      { name: 'Conamara Chaos', lat: 9.7, lon: 87.3 },
      { name: 'Pwyll Crater', lat: -25.2, lon: 88.6 },
      { name: 'Thera Macula', lat: -46.7, lon: -178.8 },
      { name: 'Tyre Crater', lat: 33.6, lon: -146.6 },
      { name: 'Cadmus Linea', lat: 27.8, lon: 172.0 },
    ],
  },
  ganymede: {
    id: 'ganymede',
    name: 'Ganymede',
    kind: 'moon',
    parentId: 'jupiter',
    realRadiusKm: 2634.1,
    visualRadius: 0.22,
    visualOrbitRadius: 4.05,
    palette: {
      primary: '#ABA194',
      secondary: '#6D655B',
      detail: '#D4CEC5',
      accent: '#C7BDB0',
      orbitColor: '#A8A29E',
    },
    axialTiltDeg: 0.33,
    rotationPeriodHours: 171.709,
    landmarks: [
      { name: 'Galileo Regio', lat: 47.0, lon: -129.6 },
      { name: 'Uruk Sulcus', lat: 0.8, lon: -160.3 },
      { name: 'Osiris Crater', lat: -38.1, lon: -166.3 },
      { name: 'Marius Regio', lat: 6.8, lon: 178.8 },
    ],
  },
  callisto: {
    id: 'callisto',
    name: 'Callisto',
    kind: 'moon',
    parentId: 'jupiter',
    realRadiusKm: 2410.3,
    visualRadius: 0.2,
    visualOrbitRadius: 5.25,
    palette: {
      primary: '#6F6862',
      secondary: '#46413D',
      detail: '#C9C3BC',
      accent: '#9E968E',
      orbitColor: '#78716C',
    },
    axialTiltDeg: 0.19,
    rotationPeriodHours: 400.536,
    landmarks: [
      { name: 'Valhalla Basin', lat: 14.7, lon: -56.0 },
      { name: 'Asgard', lat: 32.2, lon: -139.9 },
      { name: 'Gipul Catena', lat: 68.5, lon: -54.2 },
      { name: 'Burr Crater', lat: 42.7, lon: -134.5 },
    ],
  },
  saturn: {
    id: 'saturn',
    name: 'Saturn',
    kind: 'planet',
    parentId: 'sun',
    realRadiusKm: 58232,
    visualRadius: 2.05,
    visualOrbitRadius: 96,
    palette: {
      primary: '#E5CFA0',
      secondary: '#BA9F6B',
      detail: '#F5E8C8',
      accent: '#D4B47C',
      atmosphere: '#EBD9AE',
      orbitColor: '#CA8A04',
    },
    rings: {
      innerRadius: 1.3,
      outerRadius: 2.26,
      tiltDeg: 26.73,
      color: '#DEC99D',
      opacity: 0.86,
    },
    axialTiltDeg: 26.73,
    rotationPeriodHours: 10.656,
    landmarks: [
      { name: 'North Polar Hexagon', lat: 78.0, lon: 0.0 },
      { name: 'Equatorial Band', lat: 4.0, lon: 120.0 },
      { name: 'Dragon Storm', lat: -35.0, lon: -60.0 },
      { name: 'South Polar Vortex', lat: -88.0, lon: 45.0 },
    ],
  },
  enceladus: {
    id: 'enceladus',
    name: 'Enceladus',
    kind: 'moon',
    parentId: 'saturn',
    realRadiusKm: 252.1,
    visualRadius: 0.13,
    visualOrbitRadius: 2.85,
    palette: {
      primary: '#EFF4F8',
      secondary: '#BCCAD8',
      detail: '#FFFFFF',
      accent: '#7DD3FC',
      atmosphere: '#BAE6FD',
      orbitColor: '#E0F2FE',
    },
    axialTiltDeg: 0.02,
    rotationPeriodHours: 32.885,
    landmarks: [
      { name: 'Tiger Stripes', lat: -81.0, lon: 145.0 },
      { name: 'Samarkand Sulci', lat: 30.5, lon: 33.2 },
      { name: 'Damascus Sulcus', lat: -81.4, lon: -74.0 },
      { name: 'Sarandib Planitia', lat: 10.2, lon: 62.0 },
    ],
  },
  rhea: {
    id: 'rhea',
    name: 'Rhea',
    kind: 'moon',
    parentId: 'saturn',
    realRadiusKm: 763.8,
    visualRadius: 0.16,
    visualOrbitRadius: 3.85,
    palette: {
      primary: '#C9CDD2',
      secondary: '#8E949C',
      detail: '#E6E9ED',
      accent: '#A8B0BA',
      orbitColor: '#CBD5E1',
    },
    axialTiltDeg: 0.35,
    rotationPeriodHours: 108.42,
    landmarks: [
      { name: 'Tirawa Basin', lat: 34.2, lon: -151.7 },
      { name: 'Inktomi Crater', lat: -14.1, lon: -112.1 },
      { name: 'Mamaldi Crater', lat: 14.0, lon: 176.0 },
      { name: 'Powehiwehi Crater', lat: -8.2, lon: 79.6 },
    ],
  },
  titan: {
    id: 'titan',
    name: 'Titan',
    kind: 'moon',
    parentId: 'saturn',
    realRadiusKm: 2574.7,
    visualRadius: 0.24,
    visualOrbitRadius: 5.15,
    palette: {
      primary: '#DDA64B',
      secondary: '#A9722A',
      detail: '#F2CA7B',
      accent: '#E5B25D',
      atmosphere: '#F5BE5B',
      orbitColor: '#F59E0B',
    },
    axialTiltDeg: 0.3,
    rotationPeriodHours: 382.68,
    landmarks: [
      { name: 'Kraken Mare', lat: 68.0, lon: 50.0 },
      { name: 'Shangri-La', lat: -10.0, lon: -165.0 },
      { name: 'Huygens Landing', lat: -10.3, lon: -167.6 },
      { name: 'Ligeia Mare', lat: 79.0, lon: -112.0 },
      { name: 'Xanadu', lat: -15.0, lon: -100.0 },
    ],
  },
  uranus: {
    id: 'uranus',
    name: 'Uranus',
    kind: 'planet',
    parentId: 'sun',
    realRadiusKm: 25362,
    visualRadius: 1.45,
    visualOrbitRadius: 120,
    palette: {
      primary: '#8EDCE6',
      secondary: '#5BB5C5',
      detail: '#C8F1F6',
      accent: '#67E8F9',
      atmosphere: '#A5F3FC',
      orbitColor: '#06B6D4',
    },
    rings: {
      innerRadius: 1.42,
      outerRadius: 1.72,
      tiltDeg: 97.77,
      color: '#9BD5E0',
      opacity: 0.32,
    },
    axialTiltDeg: 97.77,
    rotationPeriodHours: -17.24,
    landmarks: [
      { name: 'North Polar Hood', lat: 72.0, lon: 20.0 },
      { name: 'Equatorial Collar', lat: 0.0, lon: -90.0 },
      { name: 'Berg Storm', lat: -34.0, lon: 130.0 },
      { name: 'South Polar Cap', lat: -78.0, lon: -40.0 },
    ],
  },
  titania: {
    id: 'titania',
    name: 'Titania',
    kind: 'moon',
    parentId: 'uranus',
    realRadiusKm: 788.4,
    visualRadius: 0.16,
    visualOrbitRadius: 2.6,
    palette: {
      primary: '#B8B0AA',
      secondary: '#7D7570',
      detail: '#D7D1CC',
      accent: '#9E948E',
      orbitColor: '#A8A29E',
    },
    axialTiltDeg: 0.34,
    rotationPeriodHours: 208.94,
    landmarks: [
      { name: 'Messina Chasmata', lat: -33.3, lon: -25.0 },
      { name: 'Gertrude Crater', lat: -15.8, lon: -72.9 },
      { name: 'Ursula Crater', lat: -12.4, lon: 45.2 },
      { name: 'Belmont Chasma', lat: -8.5, lon: 32.6 },
    ],
  },
  oberon: {
    id: 'oberon',
    name: 'Oberon',
    kind: 'moon',
    parentId: 'uranus',
    realRadiusKm: 761.4,
    visualRadius: 0.15,
    visualOrbitRadius: 3.65,
    palette: {
      primary: '#9D8E88',
      secondary: '#685B56',
      detail: '#C4B7B2',
      accent: '#8E7D76',
      orbitColor: '#9CA3AF',
    },
    axialTiltDeg: 0.06,
    rotationPeriodHours: 323.12,
    landmarks: [
      { name: 'Hamlet Crater', lat: -46.1, lon: 44.4 },
      { name: 'Othello Crater', lat: -66.0, lon: 42.9 },
      { name: 'Mommur Chasma', lat: -16.3, lon: -36.5 },
      { name: 'Falstaff Crater', lat: -22.1, lon: 19.0 },
    ],
  },
  neptune: {
    id: 'neptune',
    name: 'Neptune',
    kind: 'planet',
    parentId: 'sun',
    realRadiusKm: 24622,
    visualRadius: 1.4,
    visualOrbitRadius: 144,
    palette: {
      primary: '#3B66F5',
      secondary: '#1D3FA8',
      detail: '#8BB4FF',
      accent: '#60A5FA',
      atmosphere: '#4F7DF8',
      orbitColor: '#3B82F6',
    },
    axialTiltDeg: 28.32,
    rotationPeriodHours: 16.11,
    landmarks: [
      { name: 'Great Dark Spot', lat: -20.0, lon: -30.0 },
      { name: 'Scooter Cloud', lat: -42.0, lon: 55.0 },
      { name: 'North Temperate Band', lat: 34.0, lon: -140.0 },
      { name: 'South Polar Vortex', lat: -82.0, lon: 110.0 },
    ],
  },
  triton: {
    id: 'triton',
    name: 'Triton',
    kind: 'moon',
    parentId: 'neptune',
    realRadiusKm: 1353.4,
    visualRadius: 0.18,
    visualOrbitRadius: 3.3,
    palette: {
      primary: '#D8C7BC',
      secondary: '#A58E85',
      detail: '#EFE7E2',
      accent: '#93C5FD',
      atmosphere: '#CBD5E1',
      orbitColor: '#94A3B8',
    },
    axialTiltDeg: 156.8,
    rotationPeriodHours: -141.04,
    landmarks: [
      { name: 'Cantaloupe Terrain', lat: 25.0, lon: 15.0 },
      { name: 'Bubembe Regio', lat: 18.0, lon: -25.0 },
      { name: 'Monad Regio', lat: 20.0, lon: 37.0 },
      { name: 'Uhlanga Regio', lat: -37.0, lon: -3.0 },
    ],
  },
  pluto: {
    id: 'pluto',
    name: 'Pluto',
    kind: 'planet',
    parentId: 'sun',
    realRadiusKm: 1188.3,
    visualRadius: 0.44,
    visualOrbitRadius: 166,
    palette: {
      primary: '#D2C1AE',
      secondary: '#7D4F3D',
      detail: '#ECE3D8',
      accent: '#B88464',
      atmosphere: '#93C5FD',
      orbitColor: '#A78BFA',
    },
    axialTiltDeg: 122.53,
    rotationPeriodHours: -153.29,
    landmarks: [
      { name: 'Sputnik Planitia', lat: 25.0, lon: 175.0 },
      { name: 'Cthulhu Macula', lat: -5.0, lon: 90.0 },
      { name: 'Tombaugh Regio', lat: 14.0, lon: 172.0 },
      { name: 'Wright Mons', lat: -29.2, lon: 172.8 },
      { name: 'Tartarus Dorsa', lat: 8.0, lon: -118.0 },
    ],
  },
  charon: {
    id: 'charon',
    name: 'Charon',
    kind: 'moon',
    parentId: 'pluto',
    realRadiusKm: 606.0,
    visualRadius: 0.18,
    visualOrbitRadius: 2.5,
    palette: {
      primary: '#9E9B99',
      secondary: '#6B554E',
      detail: '#C9C5C2',
      accent: '#945B4D',
      orbitColor: '#94A3B8',
    },
    axialTiltDeg: 0.0,
    rotationPeriodHours: 153.29,
    landmarks: [
      { name: 'Mordor Macula', lat: 60.0, lon: 0.0 },
      { name: 'Serenity Chasma', lat: 2.0, lon: 25.0 },
      { name: 'Vulcan Planitia', lat: -25.0, lon: 10.0 },
      { name: 'Oz Terra', lat: 35.0, lon: -110.0 },
    ],
  },
}

const BODY_ID_SET = new Set<string>(SOLAR_BODY_IDS)

const MOONS_BY_PARENT: Partial<Record<CelestialBodyId, readonly CelestialBodyDef[]>> = (() => {
  const map: Partial<Record<CelestialBodyId, CelestialBodyDef[]>> = {}
  for (const id of SOLAR_BODY_IDS) {
    const def = SOLAR_BODIES[id]
    if (def.kind === 'moon' && def.parentId) {
      const list = map[def.parentId] ?? []
      list.push(def)
      map[def.parentId] = list
    }
  }
  return map
})()

export function getBodyDef(id: CelestialBodyId): CelestialBodyDef {
  return SOLAR_BODIES[id]
}

export function isCelestialBodyId(raw: unknown): raw is CelestialBodyId {
  return typeof raw === 'string' && BODY_ID_SET.has(raw)
}

export function isGeohashableBodyId(raw: unknown): raw is GeohashableBodyId {
  return typeof raw === 'string' && raw !== 'sun' && BODY_ID_SET.has(raw)
}

export function getMoonsOfBody(parentId: CelestialBodyId): CelestialBodyDef[] {
  return [...(MOONS_BY_PARENT[parentId] ?? [])]
}

// =============================================================================
// NASA JPL J2000 Keplerian Orbital Elements (Table 1 / 2a — 1800 AD to 2050 AD)
// =============================================================================

interface J2000KeplerianElements {
  readonly a: number
  readonly da: number
  readonly e: number
  readonly de: number
  readonly I: number
  readonly dI: number
  readonly L: number
  readonly dL: number
  readonly wBar: number
  readonly dwBar: number
  readonly node: number
  readonly dNode: number
}

const PLANET_KEPLER_J2000: Record<PlanetBodyId, J2000KeplerianElements> = {
  mercury: {
    a: 0.38709927,
    da: 0.00000037,
    e: 0.20563593,
    de: 0.00001906,
    I: 7.00497902,
    dI: -0.00594749,
    L: 252.2503235,
    dL: 149472.67411175,
    wBar: 77.45779628,
    dwBar: 0.16047689,
    node: 48.33076593,
    dNode: -0.12534081,
  },
  venus: {
    a: 0.72333566,
    da: 0.0000039,
    e: 0.00677672,
    de: -0.00004107,
    I: 3.39467605,
    dI: -0.0007889,
    L: 181.9790995,
    dL: 58517.81538729,
    wBar: 131.60246718,
    dwBar: 0.00268329,
    node: 76.67984255,
    dNode: -0.27769418,
  },
  earth: {
    a: 1.00000261,
    da: 0.00000562,
    e: 0.01671123,
    de: -0.00004392,
    I: -0.00001531,
    dI: -0.01294668,
    L: 100.46457166,
    dL: 35999.37244981,
    wBar: 102.93768193,
    dwBar: 0.32327364,
    node: 0.0,
    dNode: 0.0,
  },
  mars: {
    a: 1.52371034,
    da: 0.00001847,
    e: 0.0933941,
    de: 0.00007882,
    I: 1.84969142,
    dI: -0.00813131,
    L: -4.55343205,
    dL: 19140.30268499,
    wBar: -23.94362959,
    dwBar: 0.44441088,
    node: 49.55953891,
    dNode: -0.29257343,
  },
  jupiter: {
    a: 5.202887,
    da: -0.00011607,
    e: 0.04838624,
    de: -0.00013253,
    I: 1.30439695,
    dI: -0.00183714,
    L: 34.39644051,
    dL: 3034.74612775,
    wBar: 14.72847983,
    dwBar: 0.21252668,
    node: 100.47390909,
    dNode: 0.20469106,
  },
  saturn: {
    a: 9.53667594,
    da: -0.0012506,
    e: 0.05386179,
    de: -0.00050991,
    I: 2.48599187,
    dI: 0.00193609,
    L: 49.95424423,
    dL: 1222.49362201,
    wBar: 92.59887831,
    dwBar: -0.41897216,
    node: 113.66242448,
    dNode: -0.28867794,
  },
  uranus: {
    a: 19.18916464,
    da: -0.00196176,
    e: 0.04725744,
    de: -0.00004397,
    I: 0.77263783,
    dI: -0.00242939,
    L: 313.23810451,
    dL: 428.48202785,
    wBar: 170.9542763,
    dwBar: 0.40805281,
    node: 74.01692503,
    dNode: 0.04240589,
  },
  neptune: {
    a: 30.06992276,
    da: 0.00026291,
    e: 0.00859048,
    de: 0.00005105,
    I: 1.77004347,
    dI: 0.00035372,
    L: -55.12002969,
    dL: 218.45945325,
    wBar: 44.96476227,
    dwBar: -0.32241464,
    node: 131.78422574,
    dNode: -0.00508664,
  },
  pluto: {
    a: 39.48211675,
    da: -0.00031596,
    e: 0.2488273,
    de: 0.0000517,
    I: 17.14001206,
    dI: 0.00004818,
    L: 238.92903833,
    dL: 145.20780515,
    wBar: 224.06891629,
    dwBar: -0.04062942,
    node: 110.30393684,
    dNode: -0.01183482,
  },
}

interface NonEarthMoonOrbit {
  readonly periodDays: number
  readonly meanLonJ2000Deg: number
  readonly inclinationDeg: number
  readonly nodeDeg: number
  readonly parentEquatorialTiltDeg: number
  readonly parentEquatorialNodeDeg: number
}

const NON_EARTH_MOON_ORBITS: Partial<Record<CelestialBodyId, NonEarthMoonOrbit>> = {
  phobos: {
    periodDays: 0.31891023,
    meanLonJ2000Deg: 92.5,
    inclinationDeg: 1.09,
    nodeDeg: 47.0,
    parentEquatorialTiltDeg: 25.19,
    parentEquatorialNodeDeg: 82.9,
  },
  deimos: {
    periodDays: 1.2624407,
    meanLonJ2000Deg: 245.1,
    inclinationDeg: 1.79,
    nodeDeg: 316.0,
    parentEquatorialTiltDeg: 25.19,
    parentEquatorialNodeDeg: 82.9,
  },
  io: {
    periodDays: 1.769137786,
    meanLonJ2000Deg: 106.077,
    inclinationDeg: 0.05,
    nodeDeg: 43.9,
    parentEquatorialTiltDeg: 3.13,
    parentEquatorialNodeDeg: 337.9,
  },
  europa: {
    periodDays: 3.551181041,
    meanLonJ2000Deg: 175.732,
    inclinationDeg: 0.47,
    nodeDeg: 219.1,
    parentEquatorialTiltDeg: 3.13,
    parentEquatorialNodeDeg: 337.9,
  },
  ganymede: {
    periodDays: 7.15455296,
    meanLonJ2000Deg: 120.559,
    inclinationDeg: 0.2,
    nodeDeg: 63.5,
    parentEquatorialTiltDeg: 3.13,
    parentEquatorialNodeDeg: 337.9,
  },
  callisto: {
    periodDays: 16.6890184,
    meanLonJ2000Deg: 84.445,
    inclinationDeg: 0.19,
    nodeDeg: 298.8,
    parentEquatorialTiltDeg: 3.13,
    parentEquatorialNodeDeg: 337.9,
  },
  enceladus: {
    periodDays: 1.370218,
    meanLonJ2000Deg: 199.4,
    inclinationDeg: 0.02,
    nodeDeg: 169.5,
    parentEquatorialTiltDeg: 26.73,
    parentEquatorialNodeDeg: 169.5,
  },
  rhea: {
    periodDays: 4.518212,
    meanLonJ2000Deg: 358.9,
    inclinationDeg: 0.35,
    nodeDeg: 351.0,
    parentEquatorialTiltDeg: 26.73,
    parentEquatorialNodeDeg: 169.5,
  },
  titan: {
    periodDays: 15.945421,
    meanLonJ2000Deg: 163.3,
    inclinationDeg: 0.35,
    nodeDeg: 28.1,
    parentEquatorialTiltDeg: 26.73,
    parentEquatorialNodeDeg: 169.5,
  },
  titania: {
    periodDays: 8.705872,
    meanLonJ2000Deg: 24.6,
    inclinationDeg: 0.34,
    nodeDeg: 99.8,
    parentEquatorialTiltDeg: 97.77,
    parentEquatorialNodeDeg: 167.8,
  },
  oberon: {
    periodDays: 13.463239,
    meanLonJ2000Deg: 283.1,
    inclinationDeg: 0.06,
    nodeDeg: 279.8,
    parentEquatorialTiltDeg: 97.77,
    parentEquatorialNodeDeg: 167.8,
  },
  triton: {
    periodDays: -5.876854,
    meanLonJ2000Deg: 304.8,
    inclinationDeg: 23.2,
    nodeDeg: 177.6,
    parentEquatorialTiltDeg: 28.32,
    parentEquatorialNodeDeg: 131.8,
  },
  charon: {
    periodDays: 6.3872304,
    meanLonJ2000Deg: 223.0,
    inclinationDeg: 0.08,
    nodeDeg: 223.0,
    parentEquatorialTiltDeg: 122.53,
    parentEquatorialNodeDeg: 223.0,
  },
}

// =============================================================================
// Monotone Cubic Hermite (PCHIP) Compression: Heliocentric AU -> Visual Radius
// Passes cleanly through every planet's exact `visualOrbitRadius` at `a_AU`
// while keeping eccentric orbits (including Pluto) smooth and collision-free.
// =============================================================================

interface RadialSplineData {
  readonly xs: readonly number[]
  readonly ys: readonly number[]
  readonly ms: readonly number[]
}

const RADIAL_SPLINE: RadialSplineData = (() => {
  const xs = PLANET_BODY_IDS.map((id) => Math.log(PLANET_KEPLER_J2000[id].a))
  const ys = PLANET_BODY_IDS.map((id) => SOLAR_BODIES[id].visualOrbitRadius)
  const n = xs.length
  const hs: number[] = []
  const deltas: number[] = []

  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i]
    hs.push(h)
    deltas.push((ys[i + 1] - ys[i]) / h)
  }

  const ms = new Array<number>(n).fill(0)
  ms[0] = deltas[0]
  ms[n - 1] = deltas[n - 2]

  for (let i = 1; i < n - 1; i++) {
    const d0 = deltas[i - 1]
    const d1 = deltas[i]
    if (d0 * d1 <= 0) {
      ms[i] = 0
    } else {
      const w1 = 2 * hs[i] + hs[i - 1]
      const w2 = hs[i] + 2 * hs[i - 1]
      ms[i] = (w1 + w2) / (w1 / d0 + w2 / d1)
    }
  }

  return { xs, ys, ms }
})()

function auToVisualRadius(rAu: number): number {
  if (rAu <= 0) return 0
  const x = Math.log(rAu)
  const { xs, ys, ms } = RADIAL_SPLINE
  const last = xs.length - 1

  if (x <= xs[0]) {
    return Math.max(7.5, ys[0] + ms[0] * (x - xs[0]))
  }
  if (x >= xs[last]) {
    return ys[last] + ms[last] * (x - xs[last])
  }

  let lo = 0
  let hi = last - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (x < xs[mid]) {
      hi = mid - 1
    } else if (x > xs[mid + 1]) {
      lo = mid + 1
    } else {
      lo = mid
      break
    }
  }

  const h = xs[lo + 1] - xs[lo]
  const t = (x - xs[lo]) / h
  const t2 = t * t
  const t3 = t2 * t

  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2

  return h00 * ys[lo] + h10 * h * ms[lo] + h01 * ys[lo + 1] + h11 * h * ms[lo + 1]
}

// =============================================================================
// Vector & 3x3 Matrix Primitives (Zero External Dependencies)
// =============================================================================

type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function normalizeDeg(deg: number): number {
  const m = deg % 360
  return m < 0 ? m + 360 : m
}

function wrapSignedRad(rad: number): number {
  let r = (rad + Math.PI) % TWO_PI
  if (r < 0) r += TWO_PI
  return r - Math.PI
}

function vecLength(v: readonly [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2])
}

function vecNormalize(v: readonly [number, number, number]): Vec3Tuple {
  const len = Math.hypot(v[0], v[1], v[2])
  if (len <= 1e-12) return [1, 0, 0]
  return [v[0] / len, v[1] / len, v[2] / len]
}

function vecAdd(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): Vec3Tuple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function vecSub(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function vecScale(v: readonly [number, number, number], s: number): Vec3Tuple {
  return [v[0] * s, v[1] * s, v[2] * s]
}

function vecDot(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function vecCross(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function mat3MulVec(m: Mat3, v: readonly [number, number, number]): Vec3Tuple {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ]
}

function mat3Transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

/** Shortest-arc proper 3D rotation matrix mapping unit vector `from` onto unit vector `to`. */
function rotationMatrixBetweenUnitVectors(
  from: readonly [number, number, number],
  to: readonly [number, number, number]
): Mat3 {
  const c = clamp(vecDot(from, to), -1, 1)
  const cross = vecCross(from, to)
  const s = vecLength(cross)

  if (s < 1e-12) {
    if (c > 0) {
      return [1, 0, 0, 0, 1, 0, 0, 0, 1]
    }
    const fallback: Vec3Tuple = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const axis = vecNormalize(vecCross(from, fallback))
    const [kx, ky, kz] = axis
    return [
      2 * kx * kx - 1,
      2 * kx * ky,
      2 * kx * kz,
      2 * ky * kx,
      2 * ky * ky - 1,
      2 * ky * kz,
      2 * kz * kx,
      2 * kz * ky,
      2 * kz * kz - 1,
    ]
  }

  const kx = cross[0] / s
  const ky = cross[1] / s
  const kz = cross[2] / s
  const t = 1 - c

  return [
    c + kx * kx * t,
    kx * ky * t - kz * s,
    kx * kz * t + ky * s,
    ky * kx * t + kz * s,
    c + ky * ky * t,
    ky * kz * t - kx * s,
    kz * kx * t - ky * s,
    kz * ky * t + kx * s,
    c + kz * kz * t,
  ]
}

// =============================================================================
// J2000 Ephemeris Core
// =============================================================================

function julianDaysSinceJ2000(date: Date): number {
  const jd = date.getTime() / 86_400_000 + 2_440_587.5
  return jd - 2_451_545.0
}

function gmstDegrees(d: number): number {
  return normalizeDeg(280.46061837 + 360.98564736629 * d)
}

interface EvaluatedPlanetElements {
  readonly a: number
  readonly e: number
  readonly iRad: number
  readonly wRad: number
  readonly nodeRad: number
  readonly meanAnomalyRad: number
}

function evaluatePlanetElements(planetId: PlanetBodyId, julianCenturies: number): EvaluatedPlanetElements {
  const el = PLANET_KEPLER_J2000[planetId]
  const a = el.a + el.da * julianCenturies
  const e = el.e + el.de * julianCenturies
  const iDeg = el.I + el.dI * julianCenturies
  const lDeg = el.L + el.dL * julianCenturies
  const wBarDeg = el.wBar + el.dwBar * julianCenturies
  const nodeDeg = el.node + el.dNode * julianCenturies

  const wDeg = wBarDeg - nodeDeg
  const meanAnomalyRad = wrapSignedRad((lDeg - wBarDeg) * DEG2RAD)

  return {
    a,
    e,
    iRad: iDeg * DEG2RAD,
    wRad: wDeg * DEG2RAD,
    nodeRad: nodeDeg * DEG2RAD,
    meanAnomalyRad,
  }
}

function solveKeplerEquation(meanAnomalyRad: number, eccentricity: number): number {
  let E = meanAnomalyRad + eccentricity * Math.sin(meanAnomalyRad)
  for (let iter = 0; iter < 6; iter++) {
    const f = E - eccentricity * Math.sin(E) - meanAnomalyRad
    const fp = 1 - eccentricity * Math.cos(E)
    const delta = f / fp
    E -= delta
    if (Math.abs(delta) < 1e-11) break
  }
  return E
}

function keplerElementsToEclipticAu(
  elements: EvaluatedPlanetElements,
  eccentricAnomalyRad: number
): Vec3Tuple {
  const { a, e, iRad, wRad, nodeRad } = elements
  const xPrime = a * (Math.cos(eccentricAnomalyRad) - e)
  const yPrime = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(eccentricAnomalyRad)

  const cosW = Math.cos(wRad)
  const sinW = Math.sin(wRad)
  const cosO = Math.cos(nodeRad)
  const sinO = Math.sin(nodeRad)
  const cosI = Math.cos(iRad)
  const sinI = Math.sin(iRad)

  const xEcl =
    (cosW * cosO - sinW * sinO * cosI) * xPrime +
    (-sinW * cosO - cosW * sinO * cosI) * yPrime
  const yEcl =
    (cosW * sinO + sinW * cosO * cosI) * xPrime +
    (-sinW * sinO + cosW * cosO * cosI) * yPrime
  const zEcl = sinW * sinI * xPrime + cosW * sinI * yPrime

  return [xEcl, yEcl, zEcl]
}

/**
 * Computes a planet's real-time heliocentric J2000 ecliptic coordinates in AU.
 */
export function computePlanetHeliocentricEclipticAu(
  planetId: PlanetBodyId,
  date: Date = new Date()
): Vec3Tuple {
  const d = julianDaysSinceJ2000(date)
  const T = d / 36525.0
  const elements = evaluatePlanetElements(planetId, T)
  const E = solveKeplerEquation(elements.meanAnomalyRad, elements.e)
  return keplerElementsToEclipticAu(elements, E)
}

/**
 * Builds the exact proper 3D rotation matrix transforming heliocentric J2000
 * ecliptic vectors into Agnostr's Earth-centered right-handed scene frame,
 * locked cleanly so Earth's vector to the Sun matches `computeSubsolarPoint(date)`.
 */
function buildEclipticToSceneMatrix(date: Date, earthEclipticAu: Vec3Tuple): Mat3 {
  const d = julianDaysSinceJ2000(date)
  const eps = (23.439 - 0.0000004 * d) * DEG2RAD
  const gmst = gmstDegrees(d) * DEG2RAD

  const cosE = Math.cos(eps)
  const sinE = Math.sin(eps)
  const cosG = Math.cos(gmst)
  const sinG = Math.sin(gmst)

  // Ecliptic -> Equatorial (rotation around X by +eps) -> ECEF (around Z by -gmst) -> Scene (x=X, y=Z, z=-Y)
  const rawMat: Mat3 = [
    cosG,
    sinG * cosE,
    -sinG * sinE,
    0,
    sinE,
    cosE,
    sinG,
    -cosG * cosE,
    cosG * sinE,
  ]

  const sunFromEarthRaw = vecNormalize(mat3MulVec(rawMat, vecScale(earthEclipticAu, -1)))
  const subsolar = computeSubsolarPoint(date)
  const sunFromEarthExact = latLonToUnitVec3(subsolar.lat, subsolar.lon)

  const alignMat = rotationMatrixBetweenUnitVectors(sunFromEarthRaw, sunFromEarthExact)
  return mat3Mul(alignMat, rawMat)
}

// NASA/JPL NAIF pck00011.tpc: BODY3_NUT_PREC_ANGLES and BODY301_*.
// The small periodic terms keep the mean Earth/polar-axis frame (IAU_MOON)
// registered as the apparent Earth-facing point librates. Time: degrees,
// degrees/Julian century, RA sine, declination cosine, prime-meridian sine.
const LUNAR_ORIENTATION_TERMS = [
  [125.045, -1935.5364525, -3.8787, 1.5419, 3.5610],
  [250.089, -3871.072905, -0.1204, 0.0239, 0.1208],
  [260.008, 475263.3328725, 0.0700, -0.0278, -0.0642],
  [176.625, 487269.629985, -0.0172, 0.0068, 0.0158],
  [357.529, 35999.0509575, 0, 0, 0.0252],
  [311.589, 964468.49931, 0.0072, -0.0029, -0.0066],
  [134.963, 477198.869325, 0, 0.0009, -0.0047],
  [276.617, 12006.300765, 0, 0, -0.0046],
  [34.226, 63863.5132425, 0, 0, 0.0028],
  [15.134, -5806.6093575, -0.0052, 0.0008, 0.0052],
  [119.743, 131.84064, 0, 0, 0.0040],
  [239.961, 6003.1503825, 0, 0, 0.0019],
  [25.053, 473327.79642, 0.0043, -0.0009, -0.0044],
] as const

/** Lunar map coordinates (+X prime meridian, +Y north, -Z east) to Earth scene axes. */
function computeMoonToEarthAxes(d: number): Mat3 {
  // UTC is sufficient for this view's low-precision ephemeris.
  const T = d / 36525
  let ra = 269.9949 + 0.0031 * T
  let dec = 66.5392 + 0.0130 * T
  let meridian = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d
  for (const [phase, rate, raAmp, decAmp, meridianAmp] of LUNAR_ORIENTATION_TERMS) {
    const angle = (phase + rate * T) * DEG2RAD
    const sin = Math.sin(angle)
    ra += raAmp * sin
    dec += decAmp * Math.cos(angle)
    meridian += meridianAmp * sin
  }

  // Relative to the Greenwich meridian, which already rotates in the app's ECEF frame.
  const a = (ra - gmstDegrees(d)) * DEG2RAD
  const b = dec * DEG2RAD
  const w = normalizeDeg(meridian) * DEG2RAD
  const ca = Math.cos(a), sa = Math.sin(a)
  const cb = Math.cos(b), sb = Math.sin(b)
  const cw = Math.cos(w), sw = Math.sin(w)

  // Node q = (-sin(a), cos(a), 0); r = north × q. Columns
  // are (q cos(w) + r sin(w), north, q sin(w) - r cos(w)),
  // with the usual equatorial (X,Y,Z) permuted to Three.js (X,Z,-Y).
  return [
    -sa * cw - sb * ca * sw, cb * ca, -sa * sw + sb * ca * cw,
    cb * sw, sb, -cb * cw,
    -ca * cw + sb * sa * sw, -cb * sa, -ca * sw - sb * sa * cw,
  ]
}

function eclipticAuToVisualSceneOffset(eclipticAu: Vec3Tuple, eclToScene: Mat3): Vec3Tuple {
  const rAu = vecLength(eclipticAu)
  if (rAu <= 1e-12) return [0, 0, 0]
  const visualR = auToVisualRadius(rAu)
  const dirScene = vecNormalize(mat3MulVec(eclToScene, eclipticAu))
  return vecScale(dirScene, visualR)
}

function computeNonEarthMoonUnitDirScene(
  moonId: CelestialBodyId,
  dDays: number,
  eclToScene: Mat3
): Vec3Tuple {
  const orbit = NON_EARTH_MOON_ORBITS[moonId]
  if (!orbit) return [1, 0, 0]

  const meanLonRad = normalizeDeg(orbit.meanLonJ2000Deg + (360 / orbit.periodDays) * dDays) * DEG2RAD
  const u = meanLonRad - orbit.nodeDeg * DEG2RAD
  const nodeRad = orbit.nodeDeg * DEG2RAD
  const incRad = orbit.inclinationDeg * DEG2RAD

  // Unit vector in parent's equatorial plane with moon's small inclination
  const cosU = Math.cos(u)
  const sinU = Math.sin(u)
  const cosN = Math.cos(nodeRad)
  const sinN = Math.sin(nodeRad)
  const cosI = Math.cos(incRad)
  const sinI = Math.sin(incRad)

  const xEq = cosN * cosU - sinN * sinU * cosI
  const yEq = sinN * cosU + cosN * sinU * cosI
  const zEq = sinU * sinI

  // Rotate from parent equatorial plane into heliocentric ecliptic frame
  const pTilt = orbit.parentEquatorialTiltDeg * DEG2RAD
  const pNode = orbit.parentEquatorialNodeDeg * DEG2RAD
  const cosPT = Math.cos(pTilt)
  const sinPT = Math.sin(pTilt)
  const cosPN = Math.cos(pNode)
  const sinPN = Math.sin(pNode)

  const x1 = xEq
  const y1 = yEq * cosPT - zEq * sinPT
  const z1 = yEq * sinPT + zEq * cosPT

  const xEcl = x1 * cosPN - y1 * sinPN
  const yEcl = x1 * sinPN + y1 * cosPN
  const zEcl = z1

  return vecNormalize(mat3MulVec(eclToScene, [xEcl, yEcl, zEcl]))
}

function getLoomingParentRenderRadius(
  parentId: CelestialBodyId,
  focusedMoonId: GeohashableBodyId
): number {
  switch (parentId) {
    case 'earth':
      return 1.9
    case 'mars':
      return 1.3
    case 'jupiter':
      return 2.4
    case 'saturn':
      // Enceladus sits at 2.85 * 2.2 = 6.27; keep Saturn's 2.26x outer ring cleanly clear of Enceladus (r=1.0).
      return focusedMoonId === 'enceladus' ? 2.15 : 2.4
    case 'uranus':
      return 2.0
    case 'neptune':
      return 2.0
    case 'pluto':
      return 1.45
    default:
      return 1.8
  }
}

function isPlanetBodyId(id: CelestialBodyId): id is PlanetBodyId {
  return SOLAR_BODIES[id].kind === 'planet'
}

function computeRemoteMoonOffsetDistance(parentDef: CelestialBodyDef, moonDef: CelestialBodyDef): number {
  const scaled = parentDef.visualRadius * (1 + (moonDef.visualOrbitRadius - 1) * 0.7)
  const minClearance = parentDef.rings
    ? parentDef.visualRadius * parentDef.rings.outerRadius + 0.25
    : parentDef.visualRadius * 1.4
  return Math.max(scaled, minClearance)
}

// =============================================================================
// Floating-Origin Solar System Snapshot & Orbital Polylines
// =============================================================================

/**
 * Computes a complete floating-origin 3D scene snapshot for all 24 Solar System
 * bodies at `date`, anchored so `focusedBodyId` sits at `(0, 0, 0)` with
 * `renderRadius = 1.0`.
 */
export function computeSolarSystemSnapshot(
  date: Date = new Date(),
  focusedBodyId: GeohashableBodyId = 'earth'
): SolarSystemSnapshot {
  const d = julianDaysSinceJ2000(date)
  const T = d / 36525.0

  // 1. Real J2000 heliocentric ecliptic coordinates (AU) for all 9 planets
  const planetEclipticAu = {} as Record<PlanetBodyId, Vec3Tuple>
  const planetDistanceAu = {} as Record<PlanetBodyId, number>

  for (const planetId of PLANET_BODY_IDS) {
    const elements = evaluatePlanetElements(planetId, T)
    const E = solveKeplerEquation(elements.meanAnomalyRad, elements.e)
    const ecl = keplerElementsToEclipticAu(elements, E)
    planetEclipticAu[planetId] = ecl
    planetDistanceAu[planetId] = vecLength(ecl)
  }

  // 2. Align ecliptic frame to Earth's live subsolar frame
  const eclToScene = buildEclipticToSceneMatrix(date, planetEclipticAu.earth)

  // 3. Compressed visual heliocentric positions relative to Sun at (0, 0, 0)
  const planetHelioVisual = {} as Record<PlanetBodyId, Vec3Tuple>
  for (const planetId of PLANET_BODY_IDS) {
    planetHelioVisual[planetId] = eclipticAuToVisualSceneOffset(
      planetEclipticAu[planetId],
      eclToScene
    )
  }

  // 4. Unit orbital direction vectors for every moon around its parent planet
  const moonUnitDir = {} as Partial<Record<CelestialBodyId, Vec3Tuple>>
  const sublunar = computeSublunarPoint(date)
  moonUnitDir.moon = vecNormalize(latLonToUnitVec3(sublunar.lat, sublunar.lon))

  for (const id of SOLAR_BODY_IDS) {
    const def = SOLAR_BODIES[id]
    if (def.kind === 'moon' && id !== 'moon') {
      moonUnitDir[id] = computeNonEarthMoonUnitDirScene(id, d, eclToScene)
    }
  }

  const focusedDef = SOLAR_BODIES[focusedBodyId]
  const focusedIsMoon = focusedDef.kind === 'moon'
  const parentOfFocusedId: PlanetBodyId | null =
    focusedIsMoon && focusedDef.parentId && isPlanetBodyId(focusedDef.parentId)
      ? focusedDef.parentId
      : null

  // 5. Anchor planet position & Sun position in floating-origin scene coordinates
  let sunPos: Vec3Tuple
  let loomingParentPos: Vec3Tuple | null = null

  if (focusedIsMoon && parentOfFocusedId) {
    const focusedDir = moonUnitDir[focusedBodyId] ?? [1, 0, 0]
    const parentDist = focusedDef.visualOrbitRadius * 2.2
    loomingParentPos = vecScale(focusedDir, -parentDist)
    sunPos = vecSub(loomingParentPos, planetHelioVisual[parentOfFocusedId])
  } else {
    const focusedPlanetId: PlanetBodyId = isPlanetBodyId(focusedBodyId)
      ? focusedBodyId
      : 'earth'
    sunPos = vecScale(planetHelioVisual[focusedPlanetId], -1)
  }

  const moonToEarthAxes = computeMoonToEarthAxes(d)
  // Keep the active surface, camera, pins and geohashes in their common local axes.
  // Only when looking from the Moon do we rotate the sky and other bodies instead.
  const earthToViewAxes = focusedBodyId === 'moon' ? mat3Transpose(moonToEarthAxes) : null
  const toView = (v: Vec3Tuple): Vec3Tuple => earthToViewAxes ? mat3MulVec(earthToViewAxes, v) : v
  // The visually magnified Earth–Moon separation must not distort lunar phase.
  // The Solar direction from Earth and from the Moon differs by at most ~0.16°.
  const moonSunDir = vecNormalize(vecScale(planetHelioVisual.earth, -1))
  const focusedSunDir = focusedBodyId === 'moon' ? moonSunDir : vecNormalize(sunPos)

  // 6. Populate snapshot records for Sun, planets, and moons
  const bodies = {} as Record<CelestialBodyId, SolarBodySnapshot>

  bodies.sun = {
    id: 'sun',
    position: sunPos,
    renderRadius: SOLAR_BODIES.sun.visualRadius,
    sunDir: [0, 1, 0],
    distanceAuFromSun: 0,
    isFocused: false,
    isSiblingMoon: false,
    isParentOfFocused: false,
    isChildMoonOfFocused: false,
  }

  for (const planetId of PLANET_BODY_IDS) {
    const def = SOLAR_BODIES[planetId]
    const isFocused = planetId === focusedBodyId
    const isParentOfFocused = planetId === parentOfFocusedId

    let position: Vec3Tuple
    let renderRadius: number

    if (isFocused) {
      position = [0, 0, 0]
      renderRadius = 1.0
    } else if (isParentOfFocused && loomingParentPos) {
      position = loomingParentPos
      renderRadius = getLoomingParentRenderRadius(planetId, focusedBodyId)
    } else {
      position = vecAdd(sunPos, planetHelioVisual[planetId])
      renderRadius = def.visualRadius
    }

    const sunDir = isFocused ? focusedSunDir : vecNormalize(vecSub(sunPos, position))

    bodies[planetId] = {
      id: planetId,
      position,
      renderRadius,
      sunDir,
      surfaceAxes: earthToViewAxes ?? undefined,
      distanceAuFromSun: planetDistanceAu[planetId],
      isFocused,
      isSiblingMoon: false,
      isParentOfFocused,
      isChildMoonOfFocused: false,
    }
  }

  for (const id of SOLAR_BODY_IDS) {
    const def = SOLAR_BODIES[id]
    if (def.kind !== 'moon' || !def.parentId || !isPlanetBodyId(def.parentId)) continue

    const parentId = def.parentId
    const parentDef = SOLAR_BODIES[parentId]
    const parentSnap = bodies[parentId]
    const dir = moonUnitDir[id] ?? [1, 0, 0]

    const isFocused = id === focusedBodyId
    const isChildMoonOfFocused = !focusedIsMoon && parentId === focusedBodyId
    const isSiblingMoon = focusedIsMoon && !isFocused && parentId === parentOfFocusedId

    let position: Vec3Tuple
    let renderRadius: number

    if (isFocused) {
      position = [0, 0, 0]
      renderRadius = 1.0
    } else if (isChildMoonOfFocused) {
      position = vecScale(dir, def.visualOrbitRadius)
      renderRadius = clamp(def.visualRadius, 0.13, 0.22)
    } else if (isSiblingMoon) {
      position = vecAdd(parentSnap.position, vecScale(dir, def.visualOrbitRadius * 2.2))
      const ratio = def.visualRadius / Math.max(0.05, focusedDef.visualRadius)
      renderRadius = clamp(0.32 * ratio, 0.22, 0.48)
    } else {
      const remoteOrbit = computeRemoteMoonOffsetDistance(parentDef, def)
      position = vecAdd(parentSnap.position, vecScale(dir, remoteOrbit))
      renderRadius = clamp(parentDef.visualRadius * def.visualRadius * 0.85, 0.08, 0.3)
    }

    const sunDir = id === 'moon'
      ? moonSunDir
      : isFocused ? focusedSunDir : vecNormalize(vecSub(sunPos, position))

    bodies[id] = {
      id,
      position,
      renderRadius,
      sunDir,
      surfaceAxes: isFocused ? undefined : id === 'moon' ? moonToEarthAxes : earthToViewAxes ?? undefined,
      distanceAuFromSun: planetDistanceAu[parentId],
      isFocused,
      isSiblingMoon,
      isParentOfFocused: false,
      isChildMoonOfFocused,
    }
  }

  if (earthToViewAxes) {
    for (const id of SOLAR_BODY_IDS) {
      const body = bodies[id]
      bodies[id] = { ...body, position: toView(body.position), sunDir: toView(body.sunDir) }
    }
  }

  return {
    focusedBodyId,
    sunPos: bodies.sun.position,
    focusedSunDir: toView(focusedSunDir),
    earthToViewAxes,
    bodies,
  }
}

/**
 * Samples a planet's crisp inclined elliptical orbit ring around `sunPos` in the
 * current scene frame, returning `(segments + 1) * 3` packed XYZ floats forming
 * a closed 3D polyline loop.
 */
export function samplePlanetOrbitPoints(
  planetId: CelestialBodyId,
  sunPos: readonly [number, number, number],
  date: Date = new Date(),
  segments = 192,
  earthToViewAxes: Mat3 | null = null,
): Float32Array {
  if (!isPlanetBodyId(planetId)) {
    return new Float32Array(0)
  }

  const count = Math.max(16, Math.floor(segments))
  const d = julianDaysSinceJ2000(date)
  const T = d / 36525.0

  const earthElements = evaluatePlanetElements('earth', T)
  const earthE = solveKeplerEquation(earthElements.meanAnomalyRad, earthElements.e)
  const earthEclAu = keplerElementsToEclipticAu(earthElements, earthE)
  const eclToScene = buildEclipticToSceneMatrix(date, earthEclAu)

  const elements = evaluatePlanetElements(planetId, T)
  const out = new Float32Array((count + 1) * 3)

  for (let i = 0; i <= count; i++) {
    const E = i === count ? 0 : (i / count) * TWO_PI
    const eclAu = keplerElementsToEclipticAu(elements, E)
    const earthOffset = eclipticAuToVisualSceneOffset(eclAu, eclToScene)
    const offset = earthToViewAxes ? mat3MulVec(earthToViewAxes, earthOffset) : earthOffset
    const base = i * 3
    out[base] = sunPos[0] + offset[0]
    out[base + 1] = sunPos[1] + offset[1]
    out[base + 2] = sunPos[2] + offset[2]
  }

  return out
}

/**
 * Returns the nearest iconic planetary/lunar landmark name for `(lat, lon)` on
 * `bodyId` when within `maxAngularDeg` great-circle degrees, else `null`.
 */
export function findNearestCelestialLandmark(
  bodyId: GeohashableBodyId,
  lat: number,
  lon: number,
  maxAngularDeg = 30
): string | null {
  const landmarks = SOLAR_BODIES[bodyId]?.landmarks
  if (!landmarks || landmarks.length === 0) return null

  const target = latLonToUnitVec3(lat, lon)
  let bestName: string | null = null
  let bestAngleDeg = Infinity

  for (const lm of landmarks) {
    const lmVec = latLonToUnitVec3(lm.lat, lm.lon)
    const angleDeg = Math.acos(clamp(vecDot(target, lmVec), -1, 1)) * RAD2DEG
    if (angleDeg < bestAngleDeg) {
      bestAngleDeg = angleDeg
      bestName = lm.name
    }
  }

  return bestAngleDeg <= maxAngularDeg ? bestName : null
}
