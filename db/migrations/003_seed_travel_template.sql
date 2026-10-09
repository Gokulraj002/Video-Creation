-- Demo template: 4-scene travel offer (greeting, trip, price, WhatsApp CTA).
-- Every string can be overridden per campaign or filled from CSV columns.
INSERT INTO templates (name, composition_id, props, wa_template_name, wa_template_lang, wa_body_params)
VALUES (
  'Travel Offer (vertical)',
  'TravelOffer',
  '{
    "name": "{name|there}",
    "destination": "{destination|Kerala}",
    "tripTitle": "{trip|5 Days · Munnar + Alleppey}",
    "highlight1": "Private houseboat stay",
    "highlight2": "Tea garden sunrise tour",
    "highlight3": "Hotel + transfers included",
    "price": "{price|₹24,999}",
    "oldPrice": "{old_price|₹32,999}",
    "priceNote": "per person · twin sharing",
    "ctaText": "Reply YES on WhatsApp",
    "validTill": "Offer valid till 31 Oct",
    "brandName": "Your Travel Co",
    "brandColor": "#0f766e",
    "voiceText": "Hi {name|there}! Your {destination|Kerala} getaway is ready. Five days in Munnar and Alleppey, with a private houseboat stay, starting at just twenty-four thousand, nine hundred and ninety-nine rupees. Reply YES on WhatsApp, and we will lock in your dates."
  }',
  'travel_offer_video',
  'en',
  '["name|there", "destination|Kerala"]'
)
ON CONFLICT (name) DO NOTHING;
