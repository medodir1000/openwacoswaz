/**
 * ════════════════════════════════════════════════════════════════════
 *  Service-config — the dynamic multi-vertical brain of the dashboard.
 * ════════════════════════════════════════════════════════════════════
 *
 * One codhelix install serves many kinds of business. A car-rental, a
 * clinic and a restaurant all run the SAME bot + the SAME order pipeline,
 * but they speak different languages about it:
 *
 *   • the e-commerce seller thinks in "Orders / Products / Customers"
 *   • the clinic thinks in "Consultations / Services / Patients"
 *   • the car-rental thinks in "Reservations / Vehicles / Clients"
 *
 * Rather than fork the UI per vertical, the whole dashboard pivots on a
 * single `ServiceConfig` object: page titles, table column headers, stat
 * labels, the "Add …" button, empty states and the live-activity feed all
 * read their wording from here. The underlying DATA model never changes —
 * the order status enum is still pending/confirmed/dispatched/delivered/
 * cancelled in the DB; we only relabel how each vertical SEES it.
 *
 * The active vertical is driven per-seller from `sellers.business_category`
 * (migration 0009), surfaced by the brain on /funnel/billing/usage and read
 * through `useServiceConfig()`. A seller who never sets a category falls
 * back to e-commerce, which is byte-for-byte the pre-existing behaviour.
 *
 * Every string is localized inline as an {en, fr, ar} tuple — NOT via the
 * i18n catalogue — on purpose: it keeps a vertical's entire vocabulary in
 * one reviewable block instead of scattering ~400 keys across three JSON
 * files, and it lets us add a vertical without touching i18n wiring.
 */

export type Lang = 'en' | 'fr' | 'ar';

/** A single human string in the three languages the dashboard supports. */
export interface LocalizedString {
  en: string;
  fr: string;
  ar: string;
}

/**
 * The verticals the dashboard knows how to dress itself up as.
 *
 * The first eight line up with the `sellers.business_category` CHECK
 * constraint from migration 0009 (after the small rename map in
 * `resolveServiceType`). The last four (car_rental, hotel, travel_agency
 * — freelance/custom already map) are forward-declared so that the day a
 * migration widens the DB constraint, the UI already supports them with
 * zero frontend changes.
 */
export type ServiceType =
  | 'ecommerce'
  | 'car_rental'
  | 'real_estate'
  | 'restaurant'
  | 'beauty_salon'
  | 'clinic'
  | 'hotel'
  | 'travel_agency'
  | 'education'
  | 'freelance'
  | 'custom';

/**
 * The order lifecycle is FIXED in the database — the brain only ever
 * writes these five values. Per-vertical we change the DISPLAY label, not
 * the stored value, so reporting/automation stays portable across verticals.
 */
export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'dispatched'
  | 'delivered'
  | 'cancelled';

/** A noun the dashboard pluralizes (e.g. "Vehicle" / "Vehicles"). */
export interface Noun {
  singular: LocalizedString;
  plural: LocalizedString;
}

export interface ServiceConfig {
  serviceType: ServiceType;
  /** Emoji marker used in the header chip + the demo service-switcher. */
  icon: string;
  /** Short human name of the vertical itself ("Car rental", "Clinic"). */
  displayName: LocalizedString;

  // ── Core vocabulary ────────────────────────────────────────────────
  product: Noun; // what the seller offers   (Product / Vehicle / Room …)
  order: Noun; // a captured transaction      (Order / Reservation / Consultation …)
  customer: Noun; // who the bot talks to      (Customer / Patient / Guest …)

  // ── Orders / Reservations page ─────────────────────────────────────
  ordersTitle: LocalizedString; // page + sidebar heading
  ordersSubtitle: LocalizedString; // one-line description under the title
  ordersColumns: {
    when: LocalizedString;
    product: LocalizedString; // "Product" → "Vehicle" / "Property" / "Dish"
    customer: LocalizedString; // "Customer" → "Patient" / "Guest"
    phone: LocalizedString;
    address: LocalizedString; // "Address" → "Pickup point" / "Destination"
    quantity: LocalizedString; // "Qty" → "Nights" / "People" / "Days"
    total: LocalizedString;
  };
  /** How each fixed DB status is shown for THIS vertical. */
  statusLabels: Record<OrderStatus, LocalizedString>;
  emptyOrders: LocalizedString;

  // ── Products / Catalogue page ──────────────────────────────────────
  productsTitle: LocalizedString;
  productsSubtitle: LocalizedString;
  addProductLabel: LocalizedString; // "Add product" → "Add vehicle"
  emptyProducts: LocalizedString;

  // ── Live-activity feed (Dashboard overview) ────────────────────────
  // Templates filled via `fillTemplate` — {customer} and {product} get
  // substituted with the real names at render time.
  activity: {
    newOrder: LocalizedString; // "{customer} reserved {product}"
    newMessage: LocalizedString; // "{customer} is asking about {product}"
    confirmed: LocalizedString; // "{customer}'s {order} is confirmed"
  };

  // ── Agent insights (Conversations) ─────────────────────────────────
  insightsTitle: LocalizedString;
  insightsHint: LocalizedString;
}

// Compact builder — keeps each vertical's block readable.
const L = (en: string, fr: string, ar: string): LocalizedString => ({ en, fr, ar });
const N = (
  enS: string,
  frS: string,
  arS: string,
  enP: string,
  frP: string,
  arP: string,
): Noun => ({ singular: L(enS, frS, arS), plural: L(enP, frP, arP) });

// ── Reusable status-label sets ─────────────────────────────────────────
// Most verticals fall into one of four lifecycle "shapes". Defining them
// once keeps the configs DRY and the wording consistent across siblings.

/** Physical goods that get shipped (e-commerce, generic). */
const STATUS_SHIPPING: Record<OrderStatus, LocalizedString> = {
  pending: L('Pending', 'En attente', 'قيد الانتظار'),
  confirmed: L('Confirmed', 'Confirmée', 'مؤكدة'),
  dispatched: L('Dispatched', 'Expédiée', 'تم الشحن'),
  delivered: L('Delivered', 'Livrée', 'تم التسليم'),
  cancelled: L('Cancelled', 'Annulée', 'ملغاة'),
};

/** Time-slot bookings (car rental, hotel, restaurant, travel). */
const STATUS_BOOKING: Record<OrderStatus, LocalizedString> = {
  pending: L('Requested', 'Demandée', 'مطلوبة'),
  confirmed: L('Confirmed', 'Confirmée', 'مؤكدة'),
  dispatched: L('In progress', 'En cours', 'جارية'),
  delivered: L('Completed', 'Terminée', 'منتهية'),
  cancelled: L('Cancelled', 'Annulée', 'ملغاة'),
};

/** Personal-service appointments (salon, clinic, education). */
const STATUS_APPOINTMENT: Record<OrderStatus, LocalizedString> = {
  pending: L('Requested', 'Demandé', 'مطلوب'),
  confirmed: L('Confirmed', 'Confirmé', 'مؤكد'),
  dispatched: L('In progress', 'En cours', 'قيد التنفيذ'),
  delivered: L('Completed', 'Terminé', 'منتهٍ'),
  cancelled: L('Cancelled', 'Annulé', 'ملغى'),
};

/** Lead/deal pipelines that never literally "ship" (real estate, freelance). */
const STATUS_LEAD: Record<OrderStatus, LocalizedString> = {
  pending: L('New', 'Nouveau', 'جديد'),
  confirmed: L('Qualified', 'Qualifié', 'مؤهَّل'),
  dispatched: L('In progress', 'En cours', 'قيد المعالجة'),
  delivered: L('Closed', 'Conclu', 'مُنجَز'),
  cancelled: L('Lost', 'Perdu', 'ضائع'),
};

// ════════════════════════════════════════════════════════════════════════
//  THE CONFIGS — one fully-specified block per vertical.
// ════════════════════════════════════════════════════════════════════════

const CONFIGS: Record<ServiceType, ServiceConfig> = {
  // ── E-COMMERCE (default / fallback) ───────────────────────────────────
  ecommerce: {
    serviceType: 'ecommerce',
    icon: '🛍️',
    displayName: L('E-commerce', 'E-commerce', 'التجارة الإلكترونية'),
    product: N('Product', 'Produit', 'منتج', 'Products', 'Produits', 'منتجات'),
    order: N('Order', 'Commande', 'طلب', 'Orders', 'Commandes', 'طلبات'),
    customer: N('Customer', 'Client', 'زبون', 'Customers', 'Clients', 'زبائن'),
    ordersTitle: L('Orders', 'Commandes', 'الطلبات'),
    ordersSubtitle: L(
      'Every order the bot captured and confirmed',
      'Toutes les commandes capturées et confirmées par le bot',
      'كل طلب التقطه الروبوت وأكّده',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Product', 'Produit', 'المنتج'),
      customer: L('Customer', 'Client', 'الزبون'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Address', 'Adresse', 'العنوان'),
      quantity: L('Qty', 'Qté', 'الكمية'),
      total: L('Total', 'Total', 'المجموع'),
    },
    statusLabels: STATUS_SHIPPING,
    emptyOrders: L('No orders yet', 'Aucune commande', 'لا توجد طلبات بعد'),
    productsTitle: L('Products', 'Produits', 'المنتجات'),
    productsSubtitle: L(
      'The catalogue your bot sells from',
      'Le catalogue que votre bot vend',
      'الكتالوج الذي يبيع منه الروبوت',
    ),
    addProductLabel: L('Add product', 'Ajouter un produit', 'إضافة منتج'),
    emptyProducts: L(
      'No products yet — add your first one',
      'Aucun produit — ajoutez le premier',
      'لا توجد منتجات بعد — أضف أول منتج',
    ),
    activity: {
      newOrder: L(
        '{customer} ordered {product}',
        '{customer} a commandé {product}',
        '{customer} طلب {product}',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s order is confirmed",
        'La commande de {customer} est confirmée',
        'تم تأكيد طلب {customer}',
      ),
    },
    insightsTitle: L('Sales insights', 'Analyse des ventes', 'تحليلات المبيعات'),
    insightsHint: L(
      'What the bot learned from this buyer',
      'Ce que le bot a appris de cet acheteur',
      'ما تعلّمه الروبوت من هذا المشتري',
    ),
  },

  // ── CAR RENTAL ────────────────────────────────────────────────────────
  car_rental: {
    serviceType: 'car_rental',
    icon: '🚗',
    displayName: L('Car rental', 'Location de voitures', 'تأجير السيارات'),
    product: N('Vehicle', 'Véhicule', 'سيارة', 'Vehicles', 'Véhicules', 'سيارات'),
    order: N('Reservation', 'Réservation', 'حجز', 'Reservations', 'Réservations', 'حجوزات'),
    customer: N('Client', 'Client', 'عميل', 'Clients', 'Clients', 'عملاء'),
    ordersTitle: L('Reservations', 'Réservations', 'الحجوزات'),
    ordersSubtitle: L(
      'Every vehicle reservation the bot booked',
      'Toutes les réservations de véhicules prises par le bot',
      'كل حجز سيارة قام به الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Vehicle', 'Véhicule', 'السيارة'),
      customer: L('Client', 'Client', 'العميل'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Pickup point', 'Lieu de prise', 'مكان الاستلام'),
      quantity: L('Days', 'Jours', 'الأيام'),
      total: L('Total', 'Total', 'المجموع'),
    },
    statusLabels: STATUS_BOOKING,
    emptyOrders: L('No reservations yet', 'Aucune réservation', 'لا توجد حجوزات بعد'),
    productsTitle: L('Vehicles', 'Véhicules', 'السيارات'),
    productsSubtitle: L(
      'Your fleet — what the bot rents out',
      'Votre flotte — ce que le bot loue',
      'أسطولك — ما يؤجّره الروبوت',
    ),
    addProductLabel: L('Add vehicle', 'Ajouter un véhicule', 'إضافة سيارة'),
    emptyProducts: L(
      'No vehicles yet — add your first one',
      'Aucun véhicule — ajoutez le premier',
      'لا توجد سيارات بعد — أضف أول سيارة',
    ),
    activity: {
      newOrder: L(
        '{customer} reserved {product}',
        '{customer} a réservé {product}',
        '{customer} حجز {product}',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s reservation is confirmed",
        'La réservation de {customer} est confirmée',
        'تم تأكيد حجز {customer}',
      ),
    },
    insightsTitle: L('Booking insights', 'Analyse des réservations', 'تحليلات الحجوزات'),
    insightsHint: L(
      'What the bot learned from this client',
      'Ce que le bot a appris de ce client',
      'ما تعلّمه الروبوت من هذا العميل',
    ),
  },

  // ── REAL ESTATE ───────────────────────────────────────────────────────
  real_estate: {
    serviceType: 'real_estate',
    icon: '🏠',
    displayName: L('Real estate', 'Immobilier', 'العقارات'),
    product: N('Property', 'Bien', 'عقار', 'Properties', 'Biens', 'عقارات'),
    order: N('Lead', 'Demande', 'طلب', 'Leads', 'Demandes', 'طلبات'),
    customer: N('Prospect', 'Prospect', 'مهتمّ', 'Prospects', 'Prospects', 'مهتمّون'),
    ordersTitle: L('Leads', 'Demandes', 'الطلبات'),
    ordersSubtitle: L(
      'Every qualified lead the bot captured',
      'Chaque demande qualifiée captée par le bot',
      'كل طلب مؤهَّل التقطه الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Property', 'Bien', 'العقار'),
      customer: L('Prospect', 'Prospect', 'المهتمّ'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Location', 'Emplacement', 'الموقع'),
      quantity: L('Rooms', 'Pièces', 'الغرف'),
      total: L('Budget', 'Budget', 'الميزانية'),
    },
    statusLabels: STATUS_LEAD,
    emptyOrders: L('No leads yet', 'Aucune demande', 'لا توجد طلبات بعد'),
    productsTitle: L('Properties', 'Biens', 'العقارات'),
    productsSubtitle: L(
      'Listings the bot presents to prospects',
      'Les biens que le bot présente aux prospects',
      'العقارات التي يعرضها الروبوت على المهتمّين',
    ),
    addProductLabel: L('Add property', 'Ajouter un bien', 'إضافة عقار'),
    emptyProducts: L(
      'No listings yet — add your first one',
      'Aucun bien — ajoutez le premier',
      'لا توجد عقارات بعد — أضف أول عقار',
    ),
    activity: {
      newOrder: L(
        '{customer} is interested in {product}',
        '{customer} est intéressé par {product}',
        '{customer} مهتمّ بـ {product}',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        '{customer} is a qualified lead',
        '{customer} est une demande qualifiée',
        '{customer} طلب مؤهَّل',
      ),
    },
    insightsTitle: L('Lead insights', 'Analyse des demandes', 'تحليلات الطلبات'),
    insightsHint: L(
      'What the bot learned from this prospect',
      'Ce que le bot a appris de ce prospect',
      'ما تعلّمه الروبوت من هذا المهتمّ',
    ),
  },

  // ── RESTAURANT ────────────────────────────────────────────────────────
  restaurant: {
    serviceType: 'restaurant',
    icon: '🍽️',
    displayName: L('Restaurant', 'Restaurant', 'مطعم'),
    product: N('Dish', 'Plat', 'طبق', 'Menu', 'Menu', 'قائمة الطعام'),
    order: N('Reservation', 'Réservation', 'حجز', 'Reservations', 'Réservations', 'حجوزات'),
    customer: N('Guest', 'Client', 'ضيف', 'Guests', 'Clients', 'ضيوف'),
    ordersTitle: L('Reservations', 'Réservations', 'الحجوزات'),
    ordersSubtitle: L(
      'Table bookings and orders the bot took',
      'Réservations de tables et commandes prises par le bot',
      'حجوزات الطاولات والطلبات التي أخذها الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Dish', 'Plat', 'الطبق'),
      customer: L('Guest', 'Client', 'الضيف'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Address', 'Adresse', 'العنوان'),
      quantity: L('People', 'Personnes', 'الأشخاص'),
      total: L('Total', 'Total', 'المجموع'),
    },
    statusLabels: STATUS_BOOKING,
    emptyOrders: L('No reservations yet', 'Aucune réservation', 'لا توجد حجوزات بعد'),
    productsTitle: L('Menu', 'Menu', 'قائمة الطعام'),
    productsSubtitle: L(
      'The dishes your bot can take orders for',
      'Les plats pour lesquels votre bot prend des commandes',
      'الأطباق التي يأخذ الروبوت طلبات لها',
    ),
    addProductLabel: L('Add dish', 'Ajouter un plat', 'إضافة طبق'),
    emptyProducts: L(
      'No dishes yet — add your first one',
      'Aucun plat — ajoutez le premier',
      'لا توجد أطباق بعد — أضف أول طبق',
    ),
    activity: {
      newOrder: L(
        '{customer} booked a table',
        '{customer} a réservé une table',
        '{customer} حجز طاولة',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s reservation is confirmed",
        'La réservation de {customer} est confirmée',
        'تم تأكيد حجز {customer}',
      ),
    },
    insightsTitle: L('Guest insights', 'Analyse des clients', 'تحليلات الضيوف'),
    insightsHint: L(
      'What the bot learned from this guest',
      'Ce que le bot a appris de ce client',
      'ما تعلّمه الروبوت من هذا الضيف',
    ),
  },

  // ── BEAUTY SALON ──────────────────────────────────────────────────────
  beauty_salon: {
    serviceType: 'beauty_salon',
    icon: '💇',
    displayName: L('Beauty salon', 'Salon de beauté', 'صالون التجميل'),
    product: N('Service', 'Prestation', 'خدمة', 'Services', 'Prestations', 'خدمات'),
    order: N('Appointment', 'Rendez-vous', 'موعد', 'Appointments', 'Rendez-vous', 'مواعيد'),
    customer: N('Client', 'Client', 'زبون', 'Clients', 'Clients', 'زبائن'),
    ordersTitle: L('Appointments', 'Rendez-vous', 'المواعيد'),
    ordersSubtitle: L(
      'Every appointment the bot booked',
      'Tous les rendez-vous pris par le bot',
      'كل موعد حجزه الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Service', 'Prestation', 'الخدمة'),
      customer: L('Client', 'Client', 'الزبون'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Location', 'Lieu', 'المكان'),
      quantity: L('Sessions', 'Séances', 'الجلسات'),
      total: L('Total', 'Total', 'المجموع'),
    },
    statusLabels: STATUS_APPOINTMENT,
    emptyOrders: L('No appointments yet', 'Aucun rendez-vous', 'لا توجد مواعيد بعد'),
    productsTitle: L('Services', 'Prestations', 'الخدمات'),
    productsSubtitle: L(
      'The treatments your bot can book',
      'Les prestations que votre bot peut réserver',
      'الخدمات التي يمكن للروبوت حجزها',
    ),
    addProductLabel: L('Add service', 'Ajouter une prestation', 'إضافة خدمة'),
    emptyProducts: L(
      'No services yet — add your first one',
      'Aucune prestation — ajoutez la première',
      'لا توجد خدمات بعد — أضف أول خدمة',
    ),
    activity: {
      newOrder: L(
        '{customer} booked {product}',
        '{customer} a réservé {product}',
        '{customer} حجز {product}',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s appointment is confirmed",
        'Le rendez-vous de {customer} est confirmé',
        'تم تأكيد موعد {customer}',
      ),
    },
    insightsTitle: L('Client insights', 'Analyse des clients', 'تحليلات الزبائن'),
    insightsHint: L(
      'What the bot learned from this client',
      'Ce que le bot a appris de ce client',
      'ما تعلّمه الروبوت من هذا الزبون',
    ),
  },

  // ── CLINIC (health_clinic) ────────────────────────────────────────────
  clinic: {
    serviceType: 'clinic',
    icon: '🩺',
    displayName: L('Clinic', 'Clinique', 'عيادة'),
    product: N('Service', 'Service', 'خدمة', 'Services', 'Services', 'خدمات'),
    order: N('Consultation', 'Consultation', 'استشارة', 'Consultations', 'Consultations', 'استشارات'),
    customer: N('Patient', 'Patient', 'مريض', 'Patients', 'Patients', 'مرضى'),
    ordersTitle: L('Consultations', 'Consultations', 'الاستشارات'),
    ordersSubtitle: L(
      'Every consultation the bot scheduled',
      'Toutes les consultations planifiées par le bot',
      'كل استشارة حدّدها الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Service', 'Service', 'الخدمة'),
      customer: L('Patient', 'Patient', 'المريض'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Location', 'Lieu', 'المكان'),
      quantity: L('Visits', 'Visites', 'الزيارات'),
      total: L('Fee', 'Honoraires', 'الرسوم'),
    },
    statusLabels: STATUS_APPOINTMENT,
    emptyOrders: L('No consultations yet', 'Aucune consultation', 'لا توجد استشارات بعد'),
    productsTitle: L('Services', 'Services', 'الخدمات'),
    productsSubtitle: L(
      'The services your bot can schedule',
      'Les services que votre bot peut planifier',
      'الخدمات التي يمكن للروبوت تحديدها',
    ),
    addProductLabel: L('Add service', 'Ajouter un service', 'إضافة خدمة'),
    emptyProducts: L(
      'No services yet — add your first one',
      'Aucun service — ajoutez le premier',
      'لا توجد خدمات بعد — أضف أول خدمة',
    ),
    activity: {
      newOrder: L(
        '{customer} booked a consultation',
        '{customer} a pris une consultation',
        '{customer} حجز استشارة',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s consultation is confirmed",
        'La consultation de {customer} est confirmée',
        'تم تأكيد استشارة {customer}',
      ),
    },
    insightsTitle: L('Patient insights', 'Analyse des patients', 'تحليلات المرضى'),
    insightsHint: L(
      'What the bot learned from this patient',
      'Ce que le bot a appris de ce patient',
      'ما تعلّمه الروبوت من هذا المريض',
    ),
  },

  // ── HOTEL ─────────────────────────────────────────────────────────────
  hotel: {
    serviceType: 'hotel',
    icon: '🏨',
    displayName: L('Hotel', 'Hôtel', 'فندق'),
    product: N('Room', 'Chambre', 'غرفة', 'Rooms', 'Chambres', 'غرف'),
    order: N('Booking', 'Réservation', 'حجز', 'Bookings', 'Réservations', 'حجوزات'),
    customer: N('Guest', 'Client', 'نزيل', 'Guests', 'Clients', 'نزلاء'),
    ordersTitle: L('Bookings', 'Réservations', 'الحجوزات'),
    ordersSubtitle: L(
      'Every room booking the bot confirmed',
      'Toutes les réservations de chambres confirmées par le bot',
      'كل حجز غرفة أكّده الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Room', 'Chambre', 'الغرفة'),
      customer: L('Guest', 'Client', 'النزيل'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Address', 'Adresse', 'العنوان'),
      quantity: L('Nights', 'Nuits', 'الليالي'),
      total: L('Total', 'Total', 'المجموع'),
    },
    statusLabels: STATUS_BOOKING,
    emptyOrders: L('No bookings yet', 'Aucune réservation', 'لا توجد حجوزات بعد'),
    productsTitle: L('Rooms', 'Chambres', 'الغرف'),
    productsSubtitle: L(
      'The rooms your bot can book',
      'Les chambres que votre bot peut réserver',
      'الغرف التي يمكن للروبوت حجزها',
    ),
    addProductLabel: L('Add room', 'Ajouter une chambre', 'إضافة غرفة'),
    emptyProducts: L(
      'No rooms yet — add your first one',
      'Aucune chambre — ajoutez la première',
      'لا توجد غرف بعد — أضف أول غرفة',
    ),
    activity: {
      newOrder: L(
        '{customer} booked {product}',
        '{customer} a réservé {product}',
        '{customer} حجز {product}',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s booking is confirmed",
        'La réservation de {customer} est confirmée',
        'تم تأكيد حجز {customer}',
      ),
    },
    insightsTitle: L('Guest insights', 'Analyse des clients', 'تحليلات النزلاء'),
    insightsHint: L(
      'What the bot learned from this guest',
      'Ce que le bot a appris de ce client',
      'ما تعلّمه الروبوت من هذا النزيل',
    ),
  },

  // ── TRAVEL AGENCY ─────────────────────────────────────────────────────
  travel_agency: {
    serviceType: 'travel_agency',
    icon: '✈️',
    displayName: L('Travel agency', 'Agence de voyage', 'وكالة سفر'),
    product: N('Trip', 'Voyage', 'رحلة', 'Trips', 'Voyages', 'رحلات'),
    order: N('Booking', 'Réservation', 'حجز', 'Bookings', 'Réservations', 'حجوزات'),
    customer: N('Traveler', 'Voyageur', 'مسافر', 'Travelers', 'Voyageurs', 'مسافرون'),
    ordersTitle: L('Bookings', 'Réservations', 'الحجوزات'),
    ordersSubtitle: L(
      'Every trip the bot booked',
      'Tous les voyages réservés par le bot',
      'كل رحلة حجزها الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Trip', 'Voyage', 'الرحلة'),
      customer: L('Traveler', 'Voyageur', 'المسافر'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Destination', 'Destination', 'الوجهة'),
      quantity: L('Travelers', 'Voyageurs', 'المسافرون'),
      total: L('Total', 'Total', 'المجموع'),
    },
    statusLabels: STATUS_BOOKING,
    emptyOrders: L('No bookings yet', 'Aucune réservation', 'لا توجد حجوزات بعد'),
    productsTitle: L('Trips', 'Voyages', 'الرحلات'),
    productsSubtitle: L(
      'The packages your bot can sell',
      'Les forfaits que votre bot peut vendre',
      'الباقات التي يمكن للروبوت بيعها',
    ),
    addProductLabel: L('Add trip', 'Ajouter un voyage', 'إضافة رحلة'),
    emptyProducts: L(
      'No trips yet — add your first one',
      'Aucun voyage — ajoutez le premier',
      'لا توجد رحلات بعد — أضف أول رحلة',
    ),
    activity: {
      newOrder: L(
        '{customer} booked {product}',
        '{customer} a réservé {product}',
        '{customer} حجز {product}',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s trip is confirmed",
        'Le voyage de {customer} est confirmé',
        'تم تأكيد رحلة {customer}',
      ),
    },
    insightsTitle: L('Traveler insights', 'Analyse des voyageurs', 'تحليلات المسافرين'),
    insightsHint: L(
      'What the bot learned from this traveler',
      'Ce que le bot a appris de ce voyageur',
      'ما تعلّمه الروبوت من هذا المسافر',
    ),
  },

  // ── EDUCATION ─────────────────────────────────────────────────────────
  education: {
    serviceType: 'education',
    icon: '🎓',
    displayName: L('Education', 'Éducation', 'التعليم'),
    product: N('Course', 'Formation', 'دورة', 'Courses', 'Formations', 'دورات'),
    order: N('Enrollment', 'Inscription', 'تسجيل', 'Enrollments', 'Inscriptions', 'تسجيلات'),
    customer: N('Student', 'Étudiant', 'طالب', 'Students', 'Étudiants', 'طلاب'),
    ordersTitle: L('Enrollments', 'Inscriptions', 'التسجيلات'),
    ordersSubtitle: L(
      'Every enrollment the bot captured',
      'Toutes les inscriptions captées par le bot',
      'كل تسجيل التقطه الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Course', 'Formation', 'الدورة'),
      customer: L('Student', 'Étudiant', 'الطالب'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Location', 'Lieu', 'المكان'),
      quantity: L('Seats', 'Places', 'المقاعد'),
      total: L('Fee', 'Frais', 'الرسوم'),
    },
    statusLabels: STATUS_APPOINTMENT,
    emptyOrders: L('No enrollments yet', 'Aucune inscription', 'لا توجد تسجيلات بعد'),
    productsTitle: L('Courses', 'Formations', 'الدورات'),
    productsSubtitle: L(
      'The courses your bot can enroll students in',
      'Les formations où votre bot peut inscrire des étudiants',
      'الدورات التي يمكن للروبوت تسجيل الطلاب فيها',
    ),
    addProductLabel: L('Add course', 'Ajouter une formation', 'إضافة دورة'),
    emptyProducts: L(
      'No courses yet — add your first one',
      'Aucune formation — ajoutez la première',
      'لا توجد دورات بعد — أضف أول دورة',
    ),
    activity: {
      newOrder: L(
        '{customer} enrolled in {product}',
        '{customer} s’est inscrit à {product}',
        '{customer} سجّل في {product}',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s enrollment is confirmed",
        'L’inscription de {customer} est confirmée',
        'تم تأكيد تسجيل {customer}',
      ),
    },
    insightsTitle: L('Student insights', 'Analyse des étudiants', 'تحليلات الطلاب'),
    insightsHint: L(
      'What the bot learned from this student',
      'Ce que le bot a appris de cet étudiant',
      'ما تعلّمه الروبوت من هذا الطالب',
    ),
  },

  // ── FREELANCE / PROFESSIONAL SERVICES ─────────────────────────────────
  freelance: {
    serviceType: 'freelance',
    icon: '💼',
    displayName: L('Freelance', 'Freelance', 'عمل حر'),
    product: N('Service', 'Service', 'خدمة', 'Services', 'Services', 'خدمات'),
    order: N('Project', 'Projet', 'مشروع', 'Projects', 'Projets', 'مشاريع'),
    customer: N('Client', 'Client', 'عميل', 'Clients', 'Clients', 'عملاء'),
    ordersTitle: L('Projects', 'Projets', 'المشاريع'),
    ordersSubtitle: L(
      'Every project request the bot captured',
      'Toutes les demandes de projet captées par le bot',
      'كل طلب مشروع التقطه الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Service', 'Service', 'الخدمة'),
      customer: L('Client', 'Client', 'العميل'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Location', 'Lieu', 'المكان'),
      quantity: L('Hours', 'Heures', 'الساعات'),
      total: L('Budget', 'Budget', 'الميزانية'),
    },
    statusLabels: STATUS_LEAD,
    emptyOrders: L('No projects yet', 'Aucun projet', 'لا توجد مشاريع بعد'),
    productsTitle: L('Services', 'Services', 'الخدمات'),
    productsSubtitle: L(
      'The services your bot can quote',
      'Les services que votre bot peut chiffrer',
      'الخدمات التي يمكن للروبوت تسعيرها',
    ),
    addProductLabel: L('Add service', 'Ajouter un service', 'إضافة خدمة'),
    emptyProducts: L(
      'No services yet — add your first one',
      'Aucun service — ajoutez le premier',
      'لا توجد خدمات بعد — أضف أول خدمة',
    ),
    activity: {
      newOrder: L(
        '{customer} requested {product}',
        '{customer} a demandé {product}',
        '{customer} طلب {product}',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s project is confirmed",
        'Le projet de {customer} est confirmé',
        'تم تأكيد مشروع {customer}',
      ),
    },
    insightsTitle: L('Client insights', 'Analyse des clients', 'تحليلات العملاء'),
    insightsHint: L(
      'What the bot learned from this client',
      'Ce que le bot a appris de ce client',
      'ما تعلّمه الروبوت من هذا العميل',
    ),
  },

  // ── CUSTOM / OTHER (catch-all) ────────────────────────────────────────
  custom: {
    serviceType: 'custom',
    icon: '✨',
    displayName: L('Custom', 'Personnalisé', 'مخصّص'),
    product: N('Item', 'Article', 'عنصر', 'Items', 'Articles', 'عناصر'),
    order: N('Request', 'Demande', 'طلب', 'Requests', 'Demandes', 'طلبات'),
    customer: N('Contact', 'Contact', 'جهة اتصال', 'Contacts', 'Contacts', 'جهات الاتصال'),
    ordersTitle: L('Requests', 'Demandes', 'الطلبات'),
    ordersSubtitle: L(
      'Every request the bot captured',
      'Toutes les demandes captées par le bot',
      'كل طلب التقطه الروبوت',
    ),
    ordersColumns: {
      when: L('When', 'Quand', 'متى'),
      product: L('Item', 'Article', 'العنصر'),
      customer: L('Contact', 'Contact', 'جهة الاتصال'),
      phone: L('Phone', 'Téléphone', 'الهاتف'),
      address: L('Location', 'Lieu', 'الموقع'),
      quantity: L('Qty', 'Qté', 'الكمية'),
      total: L('Total', 'Total', 'المجموع'),
    },
    statusLabels: STATUS_SHIPPING,
    emptyOrders: L('No requests yet', 'Aucune demande', 'لا توجد طلبات بعد'),
    productsTitle: L('Items', 'Articles', 'العناصر'),
    productsSubtitle: L(
      'What your bot offers',
      'Ce que votre bot propose',
      'ما يقدّمه الروبوت',
    ),
    addProductLabel: L('Add item', 'Ajouter un article', 'إضافة عنصر'),
    emptyProducts: L(
      'Nothing yet — add your first one',
      'Rien pour l’instant — ajoutez le premier',
      'لا شيء بعد — أضف أول عنصر',
    ),
    activity: {
      newOrder: L(
        '{customer} requested {product}',
        '{customer} a demandé {product}',
        '{customer} طلب {product}',
      ),
      newMessage: L(
        '{customer} is asking about {product}',
        '{customer} demande des infos sur {product}',
        '{customer} يسأل عن {product}',
      ),
      confirmed: L(
        "{customer}'s request is confirmed",
        'La demande de {customer} est confirmée',
        'تم تأكيد طلب {customer}',
      ),
    },
    insightsTitle: L('Contact insights', 'Analyse des contacts', 'تحليلات جهات الاتصال'),
    insightsHint: L(
      'What the bot learned from this contact',
      'Ce que le bot a appris de ce contact',
      'ما تعلّمه الروبوت من جهة الاتصال هذه',
    ),
  },
};

/**
 * Maps a raw `sellers.business_category` value (the migration-0009 enum,
 * plus a few forward-looking aliases) onto a `ServiceType`. Anything we
 * don't recognise — including null/empty for sellers who never picked a
 * vertical — falls back to e-commerce, preserving the original behaviour.
 */
const CATEGORY_TO_SERVICE: Record<string, ServiceType> = {
  // migration-0009 enum values
  e_commerce: 'ecommerce',
  restaurant: 'restaurant',
  beauty_salon: 'beauty_salon',
  real_estate: 'real_estate',
  health_clinic: 'clinic',
  education: 'education',
  professional_services: 'freelance',
  other: 'custom',
  // direct ServiceType aliases + forward-declared verticals
  ecommerce: 'ecommerce',
  clinic: 'clinic',
  freelance: 'freelance',
  car_rental: 'car_rental',
  hotel: 'hotel',
  travel_agency: 'travel_agency',
  custom: 'custom',
};

export function resolveServiceType(businessCategory?: string | null): ServiceType {
  if (!businessCategory) return 'ecommerce';
  return CATEGORY_TO_SERVICE[businessCategory.trim().toLowerCase()] ?? 'ecommerce';
}

/**
 * The `sellers.business_category` values the DB CHECK constraint accepts
 * (migrations 0009 + 0013), in a sensible display order, each paired with
 * the ServiceType it renders as. This is the single source the Settings
 * "Business type" picker iterates over, so the dropdown can never offer a
 * value the database would reject. `freelance`/`custom` are intentionally
 * absent as raw values — they're surfaced via professional_services/other.
 */
export const BUSINESS_CATEGORY_OPTIONS: ReadonlyArray<{
  value: string;
  serviceType: ServiceType;
}> = [
  { value: 'e_commerce', serviceType: 'ecommerce' },
  { value: 'car_rental', serviceType: 'car_rental' },
  { value: 'real_estate', serviceType: 'real_estate' },
  { value: 'restaurant', serviceType: 'restaurant' },
  { value: 'beauty_salon', serviceType: 'beauty_salon' },
  { value: 'health_clinic', serviceType: 'clinic' },
  { value: 'hotel', serviceType: 'hotel' },
  { value: 'travel_agency', serviceType: 'travel_agency' },
  { value: 'education', serviceType: 'education' },
  { value: 'professional_services', serviceType: 'freelance' },
  { value: 'other', serviceType: 'custom' },
];

/** Returns the fully-specified config for a vertical (never throws). */
export function getServiceConfig(type: ServiceType): ServiceConfig {
  return CONFIGS[type] ?? CONFIGS.ecommerce;
}

/** Convenience: go straight from a DB category to its config. */
export function getServiceConfigForCategory(businessCategory?: string | null): ServiceConfig {
  return getServiceConfig(resolveServiceType(businessCategory));
}

/** All configs, ordered — handy for the demo service-switcher / settings. */
export function allServiceConfigs(): ServiceConfig[] {
  return Object.values(CONFIGS);
}

/** Normalise an i18next language code (e.g. 'fr-FR', 'ar-MA') to our keys. */
export function normalizeLang(lang?: string | null): Lang {
  const two = (lang || 'en').slice(0, 2).toLowerCase();
  if (two === 'fr') return 'fr';
  if (two === 'ar') return 'ar';
  return 'en';
}

/** Pick the right language out of a LocalizedString, defaulting to English. */
export function localize(s: LocalizedString, lang?: string | null): string {
  const key = normalizeLang(lang);
  return s[key] || s.en;
}

/**
 * Fill {placeholder} tokens in an already-localized template string.
 *   fillTemplate('{customer} ordered {product}', { customer: 'Sara', product: 'Robe' })
 *     → 'Sara ordered Robe'
 * Unknown placeholders are left untouched so a typo is visible, not silent.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}
