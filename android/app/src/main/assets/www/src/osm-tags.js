/**
 * OpenStreetMap tags -> the canonical place types in tags.js.
 *
 * Lives under public/ because both sides need it: the server uses it when it
 * proxies Overpass, and the browser uses it when it queries Overpass directly
 * with no server at all. One copy, so the two can never drift.
 */

/**
 * OSM tags -> the canonical types in public/src/tags.js.
 *
 * Checked in order: the first key present that yields a mapping wins, so the
 * specific keys come before the broad land-use ones.
 */
const AMENITY = {
  cafe: 'cafe', restaurant: 'restaurant', fast_food: 'fast_food_restaurant',
  food_court: 'food_court', ice_cream: 'ice_cream_shop', bar: 'bar', pub: 'pub',
  biergarten: 'bar', nightclub: 'night_club', casino: 'casino',
  bank: 'bank', atm: 'atm', bureau_de_change: 'bank',
  pharmacy: 'pharmacy', hospital: 'hospital', clinic: 'doctor',
  doctors: 'doctor', dentist: 'dentist', veterinary: 'veterinary_care',
  school: 'school', kindergarten: 'primary_school', college: 'university',
  university: 'university', library: 'library',
  place_of_worship: 'place_of_worship', monastery: 'place_of_worship',
  police: 'police', fire_station: 'fire_station', townhall: 'city_hall',
  courthouse: 'courthouse', post_office: 'post_office', embassy: 'embassy',
  community_centre: 'cultural_center', social_facility: 'local_government_office',
  parking: 'parking', bicycle_parking: 'parking', fuel: 'gas_station',
  charging_station: 'gas_station', car_wash: 'car_wash', car_rental: 'car_dealer',
  bus_station: 'bus_station', taxi: 'taxi_stand', ferry_terminal: 'ferry_terminal',
  cinema: 'movie_theater', theatre: 'performing_arts_theater',
  arts_centre: 'cultural_center', marketplace: 'market',
  grave_yard: 'cemetery', gym: 'gym', spa: 'spa',
  conference_centre: 'event_venue', events_venue: 'event_venue',
  studio: 'cultural_center', internet_cafe: 'cafe',
};

const SHOP = {
  supermarket: 'supermarket', convenience: 'convenience_store',
  grocery: 'grocery_store', greengrocer: 'grocery_store',
  bakery: 'bakery', pastry: 'bakery', confectionery: 'bakery',
  butcher: 'grocery_store', deli: 'meal_takeaway', coffee: 'cafe',
  books: 'book_store', clothes: 'clothing_store', shoes: 'clothing_store',
  boutique: 'clothing_store', jewelry: 'clothing_store',
  hardware: 'hardware_store', doityourself: 'hardware_store',
  trade: 'hardware_store', paint: 'hardware_store',
  alcohol: 'liquor_store', wine: 'liquor_store', beverages: 'liquor_store',
  florist: 'florist', garden_centre: 'florist',
  mall: 'shopping_mall', department_store: 'shopping_mall',
  car: 'car_dealer', car_repair: 'car_repair', car_parts: 'car_repair',
  motorcycle: 'car_dealer', tyres: 'car_repair',
  hairdresser: 'hair_care', beauty: 'beauty_salon', massage: 'spa',
  laundry: 'laundry', dry_cleaning: 'laundry',
  storage_rental: 'storage', furniture: 'store', electronics: 'store',
  mobile_phone: 'store', music: 'store', musical_instrument: 'store',
  video_games: 'store', toys: 'store', sports: 'store', pet: 'store',
  optician: 'doctor', chemist: 'pharmacy',
};

const LEISURE = {
  park: 'park', garden: 'garden', nature_reserve: 'natural_feature',
  playground: 'playground', dog_park: 'dog_park',
  pitch: 'sports_field', track: 'sports_field',
  disc_golf_course: 'sports_field', golf_course: 'golf_course',
  sports_centre: 'sports_complex', sports_hall: 'sports_complex',
  stadium: 'stadium',
  fitness_centre: 'gym', fitness_station: 'gym',
  swimming_pool: 'swimming_pool', water_park: 'swimming_pool',
  marina: 'marina', slipway: 'marina',
  bowling_alley: 'bowling_alley', amusement_arcade: 'video_arcade',
  beach_resort: 'beach', resort: 'lodging', common: 'park',
};

const TOURISM = {
  museum: 'museum', gallery: 'art_gallery', artwork: 'historical_landmark',
  hotel: 'hotel', motel: 'motel', hostel: 'hostel',
  guest_house: 'lodging', apartment: 'lodging', chalet: 'lodging',
  camp_site: 'campground', caravan_site: 'rv_park',
  attraction: 'tourist_attraction', theme_park: 'amusement_park',
  zoo: 'zoo', aquarium: 'aquarium', viewpoint: 'natural_feature',
  information: 'visitor_center', picnic_site: 'park',
};

const NATURAL = {
  water: 'water_body', bay: 'water_body', strait: 'water_body',
  wood: 'natural_feature', scrub: 'natural_feature',
  grassland: 'natural_feature', peak: 'natural_feature', beach: 'beach',
};

const WATERWAY = {
  river: 'river', stream: 'river', canal: 'river', riverbank: 'water_body',
};

const LANDUSE = {
  industrial: 'factory', retail: 'store', forest: 'natural_feature',
  cemetery: 'cemetery', residential: 'apartment_building',
};

const BUILDING = {
  apartments: 'apartment_building', residential: 'apartment_building',
  industrial: 'factory', warehouse: 'storage',
};

const RAILWAY = {
  station: 'train_station', halt: 'train_station',
  tram_stop: 'light_rail_station', subway_entrance: 'subway_station',
};

export function osmType(tags) {
  if (tags.amenity) {
    const t = AMENITY[tags.amenity];
    if (t) return t;
  }
  if (tags.shop) return SHOP[tags.shop] || 'store';
  if (tags.leisure) {
    const t = LEISURE[tags.leisure];
    if (t) return t;
  }
  if (tags.tourism) {
    const t = TOURISM[tags.tourism];
    if (t) return t;
  }
  if (tags.healthcare) return 'doctor';
  if (tags.historic) return 'historical_landmark';
  if (tags.railway) {
    const t = RAILWAY[tags.railway];
    if (t) return t;
  }
  if (tags.public_transport === 'station' || tags.public_transport === 'stop_position') {
    return 'transit_station';
  }
  if (tags.highway === 'bus_stop') return 'bus_stop';
  if (tags.office === 'government') return 'local_government_office';
  if (tags.natural) {
    const t = NATURAL[tags.natural];
    if (t) return t;
  }
  if (tags.waterway) {
    const t = WATERWAY[tags.waterway];
    if (t) return t;
  }
  // Land use and building are last: they describe an area a more specific tag
  // has usually already claimed.
  if (tags.landuse) {
    const t = LANDUSE[tags.landuse];
    if (t) return t;
  }
  if (tags.building) {
    const t = BUILDING[tags.building];
    if (t) return t;
  }
  return null;
}


/** A readable fallback name when OSM has no `name` tag. */
export function prettyOsm(type) {
  return type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
