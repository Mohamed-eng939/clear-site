-- WhatsApp and phone voice notes: .opus / .ogg, .aac, .amr, .webm
update storage.buckets set allowed_mime_types = (
  select array(select distinct unnest(allowed_mime_types || array['audio/ogg','audio/aac','audio/amr','audio/webm','audio/opus','application/ogg']))
) where id = 'materials';
