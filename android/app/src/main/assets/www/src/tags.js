/**
 * Google Maps place types translated into musical mood.
 *
 * Every place type maps to a point in a six-dimensional mood space. Nearby
 * places are averaged (weighted by distance and prominence) to produce the
 * mood vector that drives the score.
 *
 *   e  energy      how much motion and pulse the music has
 *   b  brightness  major/lydian and open filters vs. minor/phrygian and dark
 *   d  density     how many notes are happening at once
 *   t  tension     dissonance, unresolved harmony, detuning
 *   w  warmth      round analogue timbres vs. cold glassy ones
 *   s  space       reverb size, note length, sense of distance
 *
 * All values are 0..1 where 0.5 is neutral. Any dimension left out defaults to
 * neutral, which is an honest way of saying "this place type has no opinion".
 *
 * `cat` groups types for the UI legend and for naming the scene.
 *
 * Types not listed here are ignored entirely rather than being counted as
 * neutral, so vague tags like `point_of_interest` and `establishment` cannot
 * dilute the places that actually carry character.
 */

export const NEUTRAL = { e: 0.5, b: 0.5, d: 0.5, t: 0.5, w: 0.5, s: 0.5 };
export const DIMS = ['e', 'b', 'd', 't', 'w', 's'];

export const DIM_LABELS = {
  e: 'Energy',
  b: 'Brightness',
  d: 'Density',
  t: 'Tension',
  w: 'Warmth',
  s: 'Space',
};

export const CATEGORY_COLORS = {
  nature: '#6ee7a8',
  water: '#5ec8f0',
  food: '#ffb26b',
  nightlife: '#e879f9',
  retail: '#f6d36b',
  transit: '#8aa4ff',
  culture: '#c4a2ff',
  education: '#7fd7c4',
  sacred: '#dcd0ff',
  civic: '#9aa6b8',
  health: '#ff8a8a',
  sport: '#ff9f43',
  lodging: '#d7b899',
  residential: '#b8c4d4',
  industry: '#8b95a5',
  finance: '#a3b18a',
  attraction: '#ffd166',
  service: '#98a2b3',
};

export const TAG_PROFILES = {
  /* ---------------------------------------------------------- nature */
  park:              { cat: 'nature', e: 0.30, b: 0.72, d: 0.30, t: 0.12, w: 0.80, s: 0.80 },
  national_park:     { cat: 'nature', e: 0.28, b: 0.70, d: 0.22, t: 0.15, w: 0.75, s: 0.95 },
  state_park:        { cat: 'nature', e: 0.28, b: 0.70, d: 0.24, t: 0.15, w: 0.76, s: 0.92 },
  dog_park:          { cat: 'nature', e: 0.50, b: 0.78, d: 0.45, t: 0.12, w: 0.85, s: 0.65 },
  garden:            { cat: 'nature', e: 0.24, b: 0.76, d: 0.30, t: 0.10, w: 0.86, s: 0.72 },
  botanical_garden:  { cat: 'nature', e: 0.22, b: 0.78, d: 0.32, t: 0.10, w: 0.84, s: 0.78 },
  hiking_area:       { cat: 'nature', e: 0.38, b: 0.66, d: 0.24, t: 0.20, w: 0.72, s: 0.92 },
  natural_feature:   { cat: 'nature', e: 0.26, b: 0.64, d: 0.22, t: 0.18, w: 0.70, s: 0.96 },
  campground:        { cat: 'nature', e: 0.30, b: 0.60, d: 0.24, t: 0.20, w: 0.82, s: 0.90 },
  playground:        { cat: 'nature', e: 0.62, b: 0.86, d: 0.58, t: 0.10, w: 0.88, s: 0.55 },
  cemetery:          { cat: 'nature', e: 0.10, b: 0.20, d: 0.14, t: 0.52, w: 0.34, s: 0.96 },
  farm:              { cat: 'nature', e: 0.28, b: 0.62, d: 0.26, t: 0.20, w: 0.80, s: 0.82 },

  /* ----------------------------------------------------------- water */
  beach:             { cat: 'water', e: 0.36, b: 0.82, d: 0.30, t: 0.10, w: 0.76, s: 0.95 },
  marina:            { cat: 'water', e: 0.34, b: 0.68, d: 0.34, t: 0.22, w: 0.62, s: 0.86 },
  aquarium:          { cat: 'water', e: 0.28, b: 0.58, d: 0.40, t: 0.22, w: 0.58, s: 0.92 },
  swimming_pool:     { cat: 'water', e: 0.52, b: 0.74, d: 0.46, t: 0.16, w: 0.66, s: 0.72 },
  // Open water: still, wide and bright. Distinct from `natural_feature`,
  // which covers woods and hills and reads as nature rather than water.
  water_body:        { cat: 'water', e: 0.18, b: 0.72, d: 0.16, t: 0.14, w: 0.58, s: 0.98 },
  river:             { cat: 'water', e: 0.30, b: 0.68, d: 0.24, t: 0.16, w: 0.56, s: 0.94 },

  /* ------------------------------------------------------------ food */
  restaurant:        { cat: 'food', e: 0.50, b: 0.60, d: 0.60, t: 0.24, w: 0.76, s: 0.34 },
  cafe:              { cat: 'food', e: 0.40, b: 0.66, d: 0.50, t: 0.18, w: 0.86, s: 0.30 },
  coffee_shop:       { cat: 'food', e: 0.40, b: 0.66, d: 0.50, t: 0.18, w: 0.86, s: 0.30 },
  bakery:            { cat: 'food', e: 0.40, b: 0.78, d: 0.48, t: 0.14, w: 0.90, s: 0.26 },
  meal_takeaway:     { cat: 'food', e: 0.56, b: 0.60, d: 0.62, t: 0.30, w: 0.64, s: 0.28 },
  fast_food_restaurant: { cat: 'food', e: 0.62, b: 0.62, d: 0.68, t: 0.34, w: 0.56, s: 0.24 },
  ice_cream_shop:    { cat: 'food', e: 0.52, b: 0.86, d: 0.54, t: 0.10, w: 0.90, s: 0.28 },
  food_court:        { cat: 'food', e: 0.62, b: 0.62, d: 0.74, t: 0.32, w: 0.62, s: 0.38 },

  /* ------------------------------------------------------- nightlife */
  bar:               { cat: 'nightlife', e: 0.74, b: 0.48, d: 0.74, t: 0.40, w: 0.62, s: 0.38 },
  pub:               { cat: 'nightlife', e: 0.68, b: 0.50, d: 0.70, t: 0.34, w: 0.72, s: 0.36 },
  wine_bar:          { cat: 'nightlife', e: 0.52, b: 0.54, d: 0.56, t: 0.30, w: 0.78, s: 0.42 },
  night_club:        { cat: 'nightlife', e: 0.96, b: 0.44, d: 0.94, t: 0.46, w: 0.46, s: 0.34 },
  casino:            { cat: 'nightlife', e: 0.80, b: 0.58, d: 0.86, t: 0.52, w: 0.48, s: 0.40 },
  liquor_store:      { cat: 'nightlife', e: 0.54, b: 0.44, d: 0.54, t: 0.42, w: 0.56, s: 0.34 },

  /* ---------------------------------------------------------- retail */
  store:             { cat: 'retail', e: 0.50, b: 0.56, d: 0.62, t: 0.30, w: 0.52, s: 0.30 },
  shopping_mall:     { cat: 'retail', e: 0.62, b: 0.60, d: 0.82, t: 0.36, w: 0.44, s: 0.44 },
  supermarket:       { cat: 'retail', e: 0.54, b: 0.56, d: 0.70, t: 0.32, w: 0.48, s: 0.30 },
  grocery_store:     { cat: 'retail', e: 0.52, b: 0.58, d: 0.66, t: 0.30, w: 0.54, s: 0.30 },
  convenience_store: { cat: 'retail', e: 0.52, b: 0.52, d: 0.60, t: 0.36, w: 0.46, s: 0.26 },
  clothing_store:    { cat: 'retail', e: 0.56, b: 0.64, d: 0.64, t: 0.28, w: 0.54, s: 0.32 },
  book_store:        { cat: 'retail', e: 0.24, b: 0.56, d: 0.30, t: 0.16, w: 0.78, s: 0.50 },
  hardware_store:    { cat: 'retail', e: 0.46, b: 0.44, d: 0.56, t: 0.38, w: 0.44, s: 0.32 },
  florist:           { cat: 'retail', e: 0.34, b: 0.80, d: 0.40, t: 0.12, w: 0.88, s: 0.36 },
  pharmacy:          { cat: 'retail', e: 0.42, b: 0.50, d: 0.50, t: 0.44, w: 0.44, s: 0.32 },
  market:            { cat: 'retail', e: 0.66, b: 0.68, d: 0.80, t: 0.28, w: 0.70, s: 0.36 },

  /* --------------------------------------------------------- transit */
  transit_station:   { cat: 'transit', e: 0.70, b: 0.42, d: 0.80, t: 0.54, w: 0.30, s: 0.52 },
  train_station:     { cat: 'transit', e: 0.70, b: 0.44, d: 0.78, t: 0.52, w: 0.32, s: 0.66 },
  subway_station:    { cat: 'transit', e: 0.74, b: 0.32, d: 0.84, t: 0.60, w: 0.26, s: 0.48 },
  light_rail_station:{ cat: 'transit', e: 0.68, b: 0.44, d: 0.74, t: 0.50, w: 0.32, s: 0.54 },
  bus_station:       { cat: 'transit', e: 0.62, b: 0.44, d: 0.70, t: 0.48, w: 0.34, s: 0.44 },
  bus_stop:          { cat: 'transit', e: 0.54, b: 0.46, d: 0.56, t: 0.42, w: 0.38, s: 0.42 },
  airport:           { cat: 'transit', e: 0.66, b: 0.52, d: 0.86, t: 0.50, w: 0.28, s: 0.84 },
  parking:           { cat: 'transit', e: 0.34, b: 0.34, d: 0.38, t: 0.42, w: 0.28, s: 0.52 },
  gas_station:       { cat: 'transit', e: 0.46, b: 0.40, d: 0.50, t: 0.42, w: 0.34, s: 0.34 },
  taxi_stand:        { cat: 'transit', e: 0.60, b: 0.44, d: 0.62, t: 0.46, w: 0.36, s: 0.38 },
  ferry_terminal:    { cat: 'transit', e: 0.52, b: 0.56, d: 0.56, t: 0.38, w: 0.44, s: 0.84 },

  /* --------------------------------------------------------- culture */
  museum:            { cat: 'culture', e: 0.24, b: 0.50, d: 0.30, t: 0.32, w: 0.54, s: 0.86 },
  art_gallery:       { cat: 'culture', e: 0.28, b: 0.60, d: 0.34, t: 0.32, w: 0.60, s: 0.80 },
  movie_theater:     { cat: 'culture', e: 0.48, b: 0.38, d: 0.50, t: 0.48, w: 0.48, s: 0.82 },
  performing_arts_theater: { cat: 'culture', e: 0.52, b: 0.56, d: 0.56, t: 0.40, w: 0.66, s: 0.88 },
  concert_hall:      { cat: 'culture', e: 0.58, b: 0.60, d: 0.62, t: 0.34, w: 0.70, s: 0.92 },
  cultural_center:   { cat: 'culture', e: 0.40, b: 0.58, d: 0.44, t: 0.30, w: 0.62, s: 0.72 },
  historical_landmark: { cat: 'culture', e: 0.36, b: 0.56, d: 0.34, t: 0.36, w: 0.56, s: 0.90 },
  monument:          { cat: 'culture', e: 0.30, b: 0.52, d: 0.28, t: 0.42, w: 0.46, s: 0.92 },

  /* ------------------------------------------------------- education */
  school:            { cat: 'education', e: 0.52, b: 0.72, d: 0.60, t: 0.24, w: 0.72, s: 0.50 },
  primary_school:    { cat: 'education', e: 0.58, b: 0.80, d: 0.62, t: 0.18, w: 0.80, s: 0.46 },
  secondary_school:  { cat: 'education', e: 0.54, b: 0.68, d: 0.60, t: 0.28, w: 0.66, s: 0.52 },
  university:        { cat: 'education', e: 0.46, b: 0.60, d: 0.54, t: 0.30, w: 0.56, s: 0.64 },
  library:           { cat: 'education', e: 0.14, b: 0.50, d: 0.20, t: 0.16, w: 0.62, s: 0.72 },

  /* ---------------------------------------------------------- sacred */
  church:            { cat: 'sacred', e: 0.20, b: 0.56, d: 0.24, t: 0.30, w: 0.56, s: 1.00 },
  place_of_worship:  { cat: 'sacred', e: 0.20, b: 0.54, d: 0.24, t: 0.32, w: 0.54, s: 0.98 },
  mosque:            { cat: 'sacred', e: 0.22, b: 0.54, d: 0.26, t: 0.30, w: 0.58, s: 0.96 },
  synagogue:         { cat: 'sacred', e: 0.22, b: 0.52, d: 0.26, t: 0.32, w: 0.56, s: 0.96 },
  hindu_temple:      { cat: 'sacred', e: 0.30, b: 0.62, d: 0.34, t: 0.28, w: 0.64, s: 0.94 },

  /* ----------------------------------------------------------- civic */
  city_hall:         { cat: 'civic', e: 0.34, b: 0.44, d: 0.40, t: 0.52, w: 0.38, s: 0.70 },
  courthouse:        { cat: 'civic', e: 0.28, b: 0.28, d: 0.34, t: 0.72, w: 0.28, s: 0.80 },
  police:            { cat: 'civic', e: 0.50, b: 0.28, d: 0.50, t: 0.82, w: 0.24, s: 0.50 },
  fire_station:      { cat: 'civic', e: 0.56, b: 0.34, d: 0.52, t: 0.70, w: 0.30, s: 0.48 },
  post_office:       { cat: 'civic', e: 0.38, b: 0.46, d: 0.44, t: 0.40, w: 0.42, s: 0.46 },
  embassy:           { cat: 'civic', e: 0.30, b: 0.34, d: 0.34, t: 0.66, w: 0.30, s: 0.72 },
  local_government_office: { cat: 'civic', e: 0.32, b: 0.40, d: 0.40, t: 0.54, w: 0.34, s: 0.62 },

  /* ---------------------------------------------------------- health */
  hospital:          { cat: 'health', e: 0.46, b: 0.34, d: 0.52, t: 0.78, w: 0.34, s: 0.62 },
  doctor:            { cat: 'health', e: 0.34, b: 0.42, d: 0.38, t: 0.60, w: 0.40, s: 0.46 },
  dentist:           { cat: 'health', e: 0.34, b: 0.44, d: 0.40, t: 0.62, w: 0.38, s: 0.42 },
  veterinary_care:   { cat: 'health', e: 0.36, b: 0.50, d: 0.42, t: 0.52, w: 0.56, s: 0.42 },
  spa:               { cat: 'health', e: 0.14, b: 0.60, d: 0.20, t: 0.08, w: 0.86, s: 0.80 },

  /* ----------------------------------------------------------- sport */
  gym:               { cat: 'sport', e: 0.86, b: 0.54, d: 0.80, t: 0.44, w: 0.40, s: 0.28 },
  fitness_center:    { cat: 'sport', e: 0.86, b: 0.54, d: 0.80, t: 0.44, w: 0.40, s: 0.28 },
  stadium:           { cat: 'sport', e: 0.90, b: 0.62, d: 0.84, t: 0.44, w: 0.52, s: 0.88 },
  sports_complex:    { cat: 'sport', e: 0.78, b: 0.60, d: 0.74, t: 0.40, w: 0.50, s: 0.66 },
  bowling_alley:     { cat: 'sport', e: 0.70, b: 0.60, d: 0.70, t: 0.34, w: 0.56, s: 0.50 },
  // An open playing field, not a gym: green, spacious, only moderately busy.
  sports_field:      { cat: 'sport', e: 0.50, b: 0.74, d: 0.38, t: 0.16, w: 0.64, s: 0.82 },
  golf_course:       { cat: 'sport', e: 0.30, b: 0.72, d: 0.28, t: 0.18, w: 0.72, s: 0.86 },
  ski_resort:        { cat: 'sport', e: 0.66, b: 0.84, d: 0.54, t: 0.28, w: 0.44, s: 0.94 },

  /* ------------------------------------------------------- attraction */
  tourist_attraction:{ cat: 'attraction', e: 0.60, b: 0.74, d: 0.62, t: 0.26, w: 0.66, s: 0.72 },
  amusement_park:    { cat: 'attraction', e: 0.92, b: 0.88, d: 0.90, t: 0.28, w: 0.72, s: 0.52 },
  zoo:               { cat: 'attraction', e: 0.56, b: 0.72, d: 0.60, t: 0.26, w: 0.72, s: 0.62 },
  visitor_center:    { cat: 'attraction', e: 0.40, b: 0.64, d: 0.44, t: 0.24, w: 0.62, s: 0.60 },
  event_venue:       { cat: 'attraction', e: 0.72, b: 0.60, d: 0.72, t: 0.36, w: 0.58, s: 0.74 },

  /* --------------------------------------------------------- lodging */
  lodging:           { cat: 'lodging', e: 0.30, b: 0.54, d: 0.34, t: 0.22, w: 0.74, s: 0.60 },
  hotel:             { cat: 'lodging', e: 0.34, b: 0.56, d: 0.40, t: 0.24, w: 0.72, s: 0.64 },
  motel:             { cat: 'lodging', e: 0.30, b: 0.42, d: 0.34, t: 0.40, w: 0.56, s: 0.60 },
  rv_park:           { cat: 'lodging', e: 0.30, b: 0.56, d: 0.30, t: 0.22, w: 0.72, s: 0.80 },
  hostel:            { cat: 'lodging', e: 0.48, b: 0.60, d: 0.50, t: 0.26, w: 0.70, s: 0.50 },

  /* -------------------------------------------------------- industry */
  car_repair:        { cat: 'industry', e: 0.56, b: 0.34, d: 0.60, t: 0.50, w: 0.30, s: 0.34 },
  car_dealer:        { cat: 'industry', e: 0.50, b: 0.44, d: 0.56, t: 0.44, w: 0.34, s: 0.38 },
  car_wash:          { cat: 'industry', e: 0.48, b: 0.44, d: 0.52, t: 0.38, w: 0.34, s: 0.38 },
  storage:           { cat: 'industry', e: 0.34, b: 0.28, d: 0.36, t: 0.46, w: 0.24, s: 0.62 },
  moving_company:    { cat: 'industry', e: 0.46, b: 0.32, d: 0.48, t: 0.46, w: 0.28, s: 0.44 },
  electrician:       { cat: 'industry', e: 0.44, b: 0.36, d: 0.48, t: 0.44, w: 0.30, s: 0.36 },
  plumber:           { cat: 'industry', e: 0.44, b: 0.36, d: 0.48, t: 0.44, w: 0.30, s: 0.36 },
  warehouse_store:   { cat: 'industry', e: 0.48, b: 0.34, d: 0.58, t: 0.42, w: 0.28, s: 0.56 },

  /* --------------------------------------------------------- finance */
  bank:              { cat: 'finance', e: 0.40, b: 0.44, d: 0.44, t: 0.56, w: 0.30, s: 0.42 },
  atm:               { cat: 'finance', e: 0.42, b: 0.42, d: 0.46, t: 0.54, w: 0.28, s: 0.34 },
  accounting:        { cat: 'finance', e: 0.34, b: 0.40, d: 0.42, t: 0.52, w: 0.30, s: 0.42 },
  insurance_agency:  { cat: 'finance', e: 0.34, b: 0.40, d: 0.42, t: 0.54, w: 0.30, s: 0.42 },
  real_estate_agency:{ cat: 'finance', e: 0.40, b: 0.48, d: 0.46, t: 0.48, w: 0.36, s: 0.42 },
  lawyer:            { cat: 'finance', e: 0.32, b: 0.34, d: 0.40, t: 0.64, w: 0.28, s: 0.50 },

  /* ----------------------------------------------------- residential */
  apartment_building:{ cat: 'residential', e: 0.32, b: 0.52, d: 0.44, t: 0.30, w: 0.62, s: 0.44 },
  apartment_complex: { cat: 'residential', e: 0.32, b: 0.52, d: 0.46, t: 0.30, w: 0.62, s: 0.46 },
  housing_complex:   { cat: 'residential', e: 0.30, b: 0.52, d: 0.44, t: 0.30, w: 0.64, s: 0.46 },

  /* -------------------------------------------------------- civic sq */
  plaza:             { cat: 'attraction', e: 0.52, b: 0.72, d: 0.56, t: 0.22, w: 0.62, s: 0.86 },
  factory:           { cat: 'industry', e: 0.58, b: 0.28, d: 0.66, t: 0.52, w: 0.22, s: 0.60 },
  video_arcade:      { cat: 'attraction', e: 0.88, b: 0.74, d: 0.88, t: 0.30, w: 0.58, s: 0.36 },

  /* --------------------------------------------------------- service */
  hair_care:         { cat: 'service', e: 0.48, b: 0.62, d: 0.52, t: 0.24, w: 0.64, s: 0.30 },
  beauty_salon:      { cat: 'service', e: 0.48, b: 0.66, d: 0.52, t: 0.22, w: 0.68, s: 0.30 },
  laundry:           { cat: 'service', e: 0.36, b: 0.44, d: 0.42, t: 0.36, w: 0.44, s: 0.36 },
  barber_shop:       { cat: 'service', e: 0.48, b: 0.58, d: 0.52, t: 0.26, w: 0.66, s: 0.30 },
};

/** Types that carry no character — deliberately ignored. */
export const IGNORED_TYPES = new Set([
  'point_of_interest',
  'establishment',
  'premise',
  'subpremise',
  'political',
  'geocode',
  'street_address',
  'route',
  'locality',
  'neighborhood',
  'postal_code',
  'plus_code',
  'food',
  'health',
  'finance',
  'general_contractor',
  'service',
  'association_or_organization',
  'consultant',
  'transportation_service',
  'shipping_service',
  'corporate_office',
  'office',
  'supplier',
  'marketing_consultant',
  'finance_consultant',
]);

/**
 * The Places API (New) returns far more granular types than the profile table
 * defines — `italian_restaurant` rather than `restaurant`, `art_museum` rather
 * than `museum`. Enumerating every one of them would go stale the moment
 * Google adds another, so specific types fall back to the general type they
 * are a kind of. Measured against real lookups this lifts recognised type
 * mentions from about half to nearly all of them.
 */
const TYPE_ALIASES = {
  food_store: 'grocery_store',
  food_delivery: 'meal_takeaway',
  meal_delivery: 'meal_takeaway',
  catering_service: 'meal_takeaway',
  deli: 'meal_takeaway',
  sandwich_shop: 'meal_takeaway',
  salad_shop: 'meal_takeaway',
  hot_dog_stand: 'meal_takeaway',
  juice_shop: 'cafe',
  internet_cafe: 'cafe',
  tea_house: 'cafe',
  dessert_shop: 'bakery',
  confectionery: 'bakery',
  candy_store: 'bakery',
  donut_shop: 'bakery',
  chocolate_shop: 'bakery',

  government_office: 'local_government_office',
  historical_place: 'historical_landmark',
  cultural_landmark: 'historical_landmark',
  monument: 'historical_landmark',
  sculpture: 'historical_landmark',

  parking_lot: 'parking',
  parking_garage: 'parking',
  transit_stop: 'transit_station',
  transit_depot: 'bus_station',

  wedding_venue: 'event_venue',
  banquet_hall: 'event_venue',
  convention_center: 'event_venue',
  auditorium: 'event_venue',
  community_center: 'cultural_center',
  live_music_venue: 'concert_hall',
  opera_house: 'concert_hall',
  philharmonic_hall: 'concert_hall',

  manufacturer: 'factory',
  warehouse: 'storage',
  self_storage: 'storage',

  educational_institution: 'school',
  preschool: 'primary_school',

  sports_activity_location: 'sports_complex',
  sports_club: 'sports_complex',
  athletic_field: 'sports_field',
  arena: 'stadium',
  fitness_center: 'gym',

  extended_stay_hotel: 'hotel',
  resort_hotel: 'hotel',
  bed_and_breakfast: 'lodging',
  inn: 'lodging',
  guest_house: 'lodging',
  cottage: 'lodging',

  drugstore: 'pharmacy',
  dental_clinic: 'dentist',
  medical_lab: 'doctor',
  physiotherapist: 'doctor',
  wellness_center: 'spa',
  massage: 'spa',

  wildlife_park: 'zoo',
  wildlife_refuge: 'natural_feature',
  lake: 'water_body',
  pond: 'water_body',
  reservoir: 'water_body',
  waterfall: 'river',
  picnic_ground: 'park',
  barbecue_area: 'park',
  off_roading_area: 'natural_feature',

  department_store: 'shopping_mall',
  discount_store: 'store',
  warehouse_store: 'store',
  wholesaler: 'store',
  gift_shop: 'store',
  home_improvement_store: 'hardware_store',
  cell_phone_store: 'store',

  chiropractor: 'doctor',
  skin_care_clinic: 'beauty_salon',
  nail_salon: 'beauty_salon',
  tanning_studio: 'beauty_salon',

  apartment: 'apartment_building',
  condominium_complex: 'apartment_complex',
  mobile_home_park: 'rv_park',
  medical_clinic: 'doctor',
  child_care_agency: 'primary_school',
  massage_spa: 'spa',
  pizza_delivery: 'meal_takeaway',
};

/**
 * Suffix rules for the long tail. Checked in order, after the alias table.
 */
const TYPE_PATTERNS = [
  [/_restaurant$/, 'restaurant'],
  [/^(steak_house|bar_and_grill|diner|buffet_restaurant|fine_dining_restaurant)$/, 'restaurant'],
  [/_bar$|pub$|^(wine_bar|cocktail_bar|lounge_bar|beer_hall|brewery)$/, 'bar'],
  [/_museum$/, 'museum'],
  [/_school$/, 'school'],
  [/_station$/, 'transit_station'],
  [/_hotel$/, 'hotel'],
  [/_market$/, 'market'],
  [/_gallery$/, 'art_gallery'],
  [/_park$/, 'park'],
  [/_store$/, 'store'],
  [/_shop$/, 'store'],
  [/_delivery$/, 'meal_takeaway'],
  [/_clinic$/, 'doctor'],
  [/_spa$/, 'spa'],
];

/**
 * Resolve a raw Google type to one the profile table knows about, or null if
 * it carries no useful character.
 */
export function canonicalType(type) {
  if (TAG_PROFILES[type]) return type;
  if (IGNORED_TYPES.has(type)) return null;

  const alias = TYPE_ALIASES[type];
  if (alias) return TAG_PROFILES[alias] ? alias : null;

  for (const [pattern, target] of TYPE_PATTERNS) {
    if (pattern.test(type)) return TAG_PROFILES[target] ? target : null;
  }
  return null;
}

/**
 * User edits, layered over the built-in table.
 *
 * Keyed by *canonical* type: editing "restaurant" moves every kind of
 * restaurant at once, which is what you want — nobody wants to tune
 * `italian_restaurant` and `pizza_restaurant` separately.
 */
let overrides = {};

export function setTagOverrides(next) {
  overrides = { ...(next || {}) };
}

export function getTagOverrides() {
  return { ...overrides };
}

export function setTagOverride(type, partial) {
  const canonical = canonicalType(type);
  if (!canonical) return null;
  overrides[canonical] = { ...(overrides[canonical] || {}), ...partial };
  return canonical;
}

export function clearTagOverride(type) {
  const canonical = canonicalType(type);
  if (canonical) delete overrides[canonical];
  return canonical;
}

export function hasOverride(type) {
  const canonical = canonicalType(type);
  return Boolean(canonical && overrides[canonical]);
}

/** The shipped profile, ignoring edits — used by the editor's Reset. */
export function baseProfileFor(type) {
  const canonical = canonicalType(type);
  return canonical ? TAG_PROFILES[canonical] : null;
}

export function profileFor(type) {
  const canonical = canonicalType(type);
  if (!canonical) return null;
  const base = TAG_PROFILES[canonical];
  const edit = overrides[canonical];
  return edit ? { ...base, ...edit } : base;
}

export function categoryFor(type) {
  return profileFor(type)?.cat || null;
}

/** Turn `night_club` into `night club` for display. */
export function prettyTag(type) {
  return String(type).replace(/_/g, ' ');
}

/**
 * Everyday names for the "why this music" line (C4.1). Anything not listed
 * falls back to `prettyTag`, so a new type is never unnamed, just literal.
 */
const PLACE_LABELS = {
  cafe: 'café',
  internet_cafe: 'internet café',
  night_club: 'nightclub',
  transit_station: 'station',
  train_station: 'station',
  light_rail_station: 'tram stop',
  tourist_attraction: 'attraction',
  historical_landmark: 'landmark',
  historical_place: 'historic site',
  cultural_landmark: 'landmark',
  movie_theater: 'cinema',
  performing_arts_theater: 'theatre',
  meal_takeaway: 'takeaway',
  fast_food_restaurant: 'fast-food place',
  hair_care: 'hair salon',
  car_repair: 'garage',
  storage: 'storage yard',
  laundry: 'laundrette',
  police: 'police station',
  veterinary_care: 'vet',
  real_estate_agency: 'estate agent',
  local_government_office: 'council office',
  government_office: 'council office',
  parking: 'car park',
  parking_lot: 'car park',
  parking_garage: 'car park',
  natural_feature: 'natural feature',
  water_body: 'body of water',
  hiking_area: 'trail',
  atm: 'ATM',
  lodging: 'place to stay',
  sports_activity_location: 'sports ground',
  educational_institution: 'school',
};

/** The singular everyday name of a (canonical) place type. */
export function placeLabel(type) {
  return PLACE_LABELS[type] || prettyTag(type);
}

/** "a café", "an ATM", "3 cafés", "2 places of worship". */
export function countedPlaces(type, n) {
  const label = placeLabel(type);
  if (n === 1) return `${/^(?:uni|use|eu|one)/i.test(label) || !/^[aeiou]/i.test(label) ? 'a' : 'an'} ${label}`;
  return `${n} ${pluralise(label)}`;
}

/** English plural of a label; for "place of worship" the head noun changes. */
function pluralise(label) {
  const of = label.indexOf(' of ');
  if (of > 0) return pluralise(label.slice(0, of)) + label.slice(of);
  if (/(?:s|x|z|ch|sh)$/i.test(label)) return `${label}es`;
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}
