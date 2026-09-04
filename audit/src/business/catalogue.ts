/**
 * Small catalogue of commercially important UK local-service categories.
 * Each entry gives the phrasing needed to build one well-designed test per layer.
 * Keep it focused: this is a lead-generation tool, not a taxonomy.
 */
export interface ServiceProfile {
  /** Canonical service label, e.g. "roofing". */
  service: string;
  /** Keywords that identify this service in a business name or website text. */
  keywords: string[];
  /** Plural provider noun for discovery queries. */
  providerNoun: string;
  /** Requirement phrase used in the recommendation test. */
  requirement: string;
  /** Natural first-person problem description (without the location, which is appended). */
  problem: string;
  /** Generic words that belong to the service and are not distinctive in a business name. */
  genericWords: string[];
}

export const SERVICE_CATALOGUE: ServiceProfile[] = [
  {
    service: 'roofing',
    keywords: ['roof', 'roofing', 'roofer', 'roofers', 'guttering', 'fascias', 'flat roof'],
    providerNoun: 'roofing companies',
    requirement: 'roof repairs',
    problem:
      "My roof has started leaking around the chimney after the recent rain and I'm not sure whether it needs repairing or replacing. What should I do?",
    genericWords: ['roofing', 'roofers', 'roofer', 'roof', 'roofs', 'guttering'],
  },
  {
    service: 'plumbing',
    keywords: ['plumb', 'plumber', 'plumbing', 'heating', 'boiler', 'gas safe'],
    providerNoun: 'plumbers',
    requirement: 'fixing a leaking pipe',
    problem:
      "There's water dripping from under my kitchen sink and the cupboard is soaked. I've turned the stop tap off for now. What should I do?",
    genericWords: ['plumbing', 'plumbers', 'plumber', 'heating', 'gas', 'boilers'],
  },
  {
    service: 'electrical',
    keywords: ['electric', 'electrician', 'electrical', 'rewire', 'niceic'],
    providerNoun: 'electricians',
    requirement: 'electrical repairs',
    problem:
      'Half the sockets in my living room have stopped working and the fuse box keeps tripping. What should I do?',
    genericWords: ['electrical', 'electricians', 'electrician', 'electrics'],
  },
  {
    service: 'building',
    keywords: ['builder', 'builders', 'building', 'construction', 'extension', 'loft conversion'],
    providerNoun: 'builders',
    requirement: 'a home extension',
    problem:
      "We want to add a single-storey extension to the back of our house but have no idea where to start or what it might cost. What should we do first?",
    genericWords: ['building', 'builders', 'builder', 'construction', 'developments'],
  },
  {
    service: 'landscaping',
    keywords: ['landscap', 'garden', 'gardening', 'paving', 'driveway', 'fencing', 'tree surgeon'],
    providerNoun: 'landscape gardeners',
    requirement: 'landscaping work',
    problem:
      'Our back garden is a mess of patchy lawn and broken fencing and we want it made usable for the kids. Where should we start?',
    genericWords: ['landscaping', 'landscapes', 'gardens', 'garden', 'gardening', 'paving', 'driveways'],
  },
  {
    service: 'cleaning',
    keywords: ['clean', 'cleaning', 'cleaners', 'carpet cleaning', 'window cleaning'],
    providerNoun: 'cleaning companies',
    requirement: 'a regular house clean',
    problem:
      "I'm struggling to keep on top of the housework with two jobs and want someone reliable to clean fortnightly. How do I go about finding someone?",
    genericWords: ['cleaning', 'cleaners', 'cleaner', 'clean'],
  },
  {
    service: 'locksmith',
    keywords: ['locksmith', 'locks', 'key cutting'],
    providerNoun: 'locksmiths',
    requirement: 'changing the locks',
    problem:
      "I've just moved into a new flat and I'm not comfortable that the previous tenants might still have keys. What should I do?",
    genericWords: ['locksmiths', 'locksmith', 'locks', 'security'],
  },
  {
    service: 'dental',
    keywords: ['dental', 'dentist', 'orthodont', 'smile'],
    providerNoun: 'dentists',
    requirement: 'a dental check-up',
    problem:
      "I've got a nagging toothache at the back that gets worse with cold drinks and I haven't seen a dentist in years. What should I do?",
    genericWords: ['dental', 'dentist', 'dentists', 'dentistry', 'practice', 'clinic', 'smile'],
  },
  {
    service: 'accountancy',
    keywords: ['account', 'accountant', 'bookkeep', 'tax'],
    providerNoun: 'accountants',
    requirement: 'small business accounts',
    problem:
      "I've just gone self-employed and the tax side is completely baffling me. I want to make sure I don't get it wrong. What should I do?",
    genericWords: ['accountants', 'accountancy', 'accounting', 'bookkeeping', 'tax', 'associates', 'partners'],
  },
  {
    service: 'legal',
    keywords: ['solicitor', 'solicitors', 'law', 'legal', 'conveyanc'],
    providerNoun: 'solicitors',
    requirement: 'conveyancing on a house purchase',
    problem:
      "We've had an offer accepted on a house and the estate agent is asking who our solicitor is. We don't have one yet. What should we do?",
    genericWords: ['solicitors', 'solicitor', 'law', 'legal', 'llp', 'partners'],
  },
  {
    service: 'estate agency',
    keywords: ['estate agent', 'estate agents', 'lettings', 'property', 'sales & lettings'],
    providerNoun: 'estate agents',
    requirement: 'selling a house',
    problem:
      "We're thinking of selling our three-bed semi and are not sure whether to go with a high-street agent or an online one. What should we do?",
    genericWords: ['estate', 'agents', 'agent', 'property', 'properties', 'lettings', 'homes'],
  },
  {
    service: 'car repair',
    keywords: ['garage', 'mot', 'mechanic', 'auto', 'motors', 'tyres', 'car repair'],
    providerNoun: 'car garages',
    requirement: 'an MOT and service',
    problem:
      "My car's making a grinding noise when I brake and the MOT is due next month. What should I do?",
    genericWords: ['garage', 'motors', 'autos', 'auto', 'automotive', 'mot', 'tyres'],
  },
  {
    service: 'removals',
    keywords: ['removal', 'removals', 'movers', 'man and van', 'storage'],
    providerNoun: 'removal companies',
    requirement: 'moving house',
    problem:
      "We're moving to a new house in three weeks and have far more stuff than will fit in a van. How should we go about it?",
    genericWords: ['removals', 'removal', 'movers', 'storage', 'transport'],
  },
];

/**
 * Words that describe a trade rather than identify a business. A candidate made only of
 * these (plus location / legal words) is a description such as "Tiling" or "Wendover Tilers",
 * never evidence that a particular prospect appeared.
 */
export const TRADE_WORDS = [
  'tiling', 'tiler', 'tilers', 'tiles', 'tile', 'flooring', 'floors', 'floor', 'plastering', 'plasterer', 'plasterers',
  'decorating', 'decorators', 'decorator', 'painting', 'painters', 'painter', 'joinery', 'joiners', 'carpentry',
  'carpenter', 'carpenters', 'bricklaying', 'bricklayers', 'scaffolding', 'glazing', 'windows', 'doors', 'kitchens',
  'bathrooms', 'bathroom', 'kitchen', 'fencing', 'paving', 'driveways', 'drainage', 'groundworks', 'demolition',
  'surveying', 'surveyors', 'architects', 'architecture', 'photography', 'catering', 'restoration', 'renovation',
  'renovations', 'refurbishment', 'maintenance', 'repairs', 'repair', 'installations', 'installation', 'installers',
  'handyman', 'property', 'home', 'improvements', 'interiors', 'exteriors', 'stone', 'marble', 'mosaic', 'ceramics',
  'plumbing', 'heating', 'roofing', 'roofers', 'building', 'builders', 'construction', 'electrical', 'electricians',
  'landscaping', 'gardens', 'cleaning', 'cleaners', 'locksmiths', 'removals', 'dental', 'accountants', 'solicitors',
  // Rooms, surfaces and jobs. A candidate made only of these ("Kitchen splashback", "Hallway/kitchen floor")
  // is a job description from a price guide or portfolio, never a business.
  'splashback', 'splashbacks', 'hallway', 'hallways', 'wall', 'walls', 'floors', 'ensuite', 'en-suite', 'shower',
  'showers', 'wetroom', 'wetrooms', 'wet', 'room', 'rooms', 'utility', 'porch', 'conservatory', 'patio', 'patios',
  'decking', 'terrace', 'steps', 'grout', 'grouting', 'regrout', 'regrouting', 'underfloor', 'porcelain', 'ceramic',
  'slate', 'quarry', 'laminate', 'vinyl', 'lvt', 'carpet', 'carpets', 'skirting', 'worktop', 'worktops', 'cabinets',
  'fitting', 'fitted', 'fit', 'refit', 'refits', 'refurb', 'makeover', 'upgrade', 'replacement', 'replacements',
  'living', 'lounge', 'bedroom', 'bedrooms', 'downstairs', 'upstairs', 'garage', 'loft', 'extension', 'extensions',
];

export const GENERIC_BUSINESS_WORDS = [
  'ltd',
  'limited',
  'llp',
  'plc',
  'co',
  'company',
  'services',
  'service',
  'solutions',
  'group',
  'the',
  'and',
  '&',
  'uk',
  'south',
  'north',
  'east',
  'west',
  'local',
  'specialists',
  'specialist',
  'contractors',
  'contractor',
  'experts',
  'trades',
];
