INSERT INTO templates (name, composition_id, props, wa_template_name, wa_template_lang, wa_body_params)
VALUES (
  'Personalized Intro (vertical)',
  'PersonalizedIntro',
  '{
    "headline": "Hi {name|there}!",
    "subline": "We have something special for you in {city|your city}",
    "brandName": "Your Brand",
    "brandColor": "#4f46e5",
    "voiceText": "Hi {name|there}, this video is just for you."
  }',
  'personalized_video',
  'en',
  '["name|there"]'
)
ON CONFLICT (name) DO NOTHING;
