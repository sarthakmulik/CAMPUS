-- =============================================================================
-- 0048b — CAMPUS PULSE seed: engine configuration + the first approved
-- content library (real product copy, authored for CAMPUS; NOT generated
-- results or fabricated engagement).
--
-- Idempotent: every item inserts only when its body text is not already in
-- the library. Re-running never duplicates.
--
-- Campus Pulse templates may substitute approved topic labels (see the
-- "wi-fi/canteen" improvement question) — option text stays fixed.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Engine configuration (mirrored in src/lib/pulse/config.ts — keep in sync)
-- ---------------------------------------------------------------------------
insert into public.pulse_config (key, value) values
  ('pulse.weight.relevance',          to_jsonb(0.30)),
  ('pulse.weight.quality',            to_jsonb(0.25)),
  ('pulse.weight.freshness',          to_jsonb(0.20)),
  ('pulse.weight.engagement',         to_jsonb(0.15)),
  ('pulse.weight.diversity',          to_jsonb(0.10)),
  ('pulse.minSample',                 to_jsonb(10)),
  ('pulse.trendMinLiftPts',           to_jsonb(5)),
  ('pulse.freshnessDays',             to_jsonb(14)),
  ('pulse.engagementPriorStrength',   to_jsonb(20)),
  ('pulse.engagementBaseline',        to_jsonb(0.60)),
  ('pulse.statementDeck',             to_jsonb(5)),
  ('pulse.seasonCategories',          '[{"months":[10,11,12,1],"categories":["exams"]},{"months":[2,3],"categories":["fests"]}]'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Daily check-in questions (2–6 emoji options each)
-- ---------------------------------------------------------------------------
insert into public.pulse_items (kind, category, body, options, status, evergreen)
select 'question', v.category, v.body, v.options::jsonb, 'approved', true
from (values
  ('campus_life', 'How''s college life treating you this week?',
   '[{"emoji":"😎","label":"We''re cooking"},{"emoji":"🙂","label":"Doing okay"},{"emoji":"🥲","label":"Just surviving"},{"emoji":"💀","label":"Send help"}]'),
  ('exams', 'Which enemy are you fighting this exam season?',
   '[{"emoji":"📚","label":"The syllabus"},{"emoji":"⏰","label":"The clock"},{"emoji":"🛋️","label":"My bed"},{"emoji":"📶","label":"The Wi-Fi"}]'),
  ('food', 'What is canteen food really like right now?',
   '[{"emoji":"😋","label":"Peak canteen day"},{"emoji":"😐","label":"Edible, barely"},{"emoji":"🏃","label":"I eat outside"},{"emoji":"💀","label":"Risking it daily"}]'),
  ('hostel', 'Late night at the hostel — what''s the plan?',
   '[{"emoji":"🎧","label":"Music and vibes"},{"emoji":"📖","label":"Last-minute study"},{"emoji":"🎮","label":"Games till 3 AM"},{"emoji":"😴","label":"Out by 11 PM"}]'),
  ('campus_life', 'Be honest — how''s your attendance this month?',
   '[{"emoji":"🏅","label":"Full attendance hero"},{"emoji":"😅","label":"Just above the line"},{"emoji":"😬","label":"Condolence meeting soon"},{"emoji":"🙈","label":"What attendance?"}]'),
  ('exams', 'How are the internals going for you?',
   '[{"emoji":"✅","label":"Sorted"},{"emoji":"📘","label":"One night before"},{"emoji":"🫠","label":"Group study panic"},{"emoji":"🎲","label":"Praying to the curve"}]'),
  ('commute', 'What''s your daily commute to campus like?',
   '[{"emoji":"🚌","label":"Packed bus ritual"},{"emoji":"🚲","label":"Cycle freedom"},{"emoji":"🛵","label":"Quick two-wheeler"},{"emoji":"🚶","label":"Walk and podcast"}]'),
  ('campus_lib', 'The library on a normal weekday is mostly…',
   '[{"emoji":"🤫","label":"Silent and sacred"},{"emoji":"👥","label":"Discussion corner chaos"},{"emoji":"❄️","label":"AC sleeping hall"},{"emoji":"🔐","label":"Seat mafia territory"}]'),
  ('campus_improve', 'Which part of campus life needs the most improvement right now?',
   '[{"emoji":"🛜","label":"Campus Wi-Fi"},{"emoji":"🍱","label":"Canteen"},{"emoji":"🚌","label":"Transport"},{"emoji":"📚","label":"Library"},{"emoji":"🎉","label":"Student activities"}]'),
  ('fests', 'What''s the best part of a college fest?',
   '[{"emoji":"🎤","label":"The concerts"},{"emoji":"🎪","label":"The stalls"},{"emoji":"🏆","label":"The competitions"},{"emoji":"📸","label":"The photos"}]'),
  ('campus_life', 'Pick your honest productivity hour on campus:',
   '[{"emoji":"🌅","label":"Early morning grinder"},{"emoji":"☀️","label":"Between lectures"},{"emoji":"🌙","label":"After sunset burst"},{"emoji":"🦉","label":"2 AM wizardry only"}]'),
  ('exams', 'Your group project role, honestly:',
   '[{"emoji":"🧠","label":"I do everything"},{"emoji":"🎨","label":"Slides and vibes"},{"emoji":"💬","label":"I coordinate"},{"emoji":"👻","label":"I appear at viva"}]')
) as v(category, body, options)
where not exists (select 1 from public.pulse_items t where t.body = v.body);

-- ---------------------------------------------------------------------------
-- Am I the Only One? — relatable statements (finite daily deck rotates
-- through these; reactions aggregate anonymously)
-- ---------------------------------------------------------------------------
insert into public.pulse_items (kind, category, body, status, evergreen)
select 'statement', v.category, v.body, 'approved', true
from (values
  ('exams',      'I start studying seriously only when the exam timetable comes out.'),
  ('lectures',   'The best lecture is the cancelled one.'),
  ('laptop',     'I open my laptop to study and somehow accomplish everything except studying.'),
  ('hostel',     'Hostel food tastes 10x better the day before the mess inspection.'),
  ('attendance', '75% attendance means I attended exactly the classes that had surprise quizzes.'),
  ('sleep',      'My sleep schedule is set to "one more episode" timezone.'),
  ('group',      'Every group project has that one member who appears only at the viva.'),
  ('canteen',    'I have strong opinions about canteen samosa quality and I will defend them.'),
  ('project',    'My project works on demo day. It has never worked since.'),
  ('notes',      'The class topper''s notes are my primary study material and I am not ashamed.'),
  ('wifi',       'Campus Wi-Fi works perfectly until you actually need it for a submission.'),
  ('intro',      'I planned to make new friends this year, and mainly made new dishes in the mess queue.'),
  ('timetable',  'My timetable is beautiful on paper and fiction in real life.'),
  ('deadline',   'Deadlines are just suggestions with consequences.')
) as v(category, body)
where not exists (select 1 from public.pulse_items t where t.body = v.body);

-- ---------------------------------------------------------------------------
-- Campus Personality quizzes (deterministic trait scoring — every option
-- carries a trait index; ties resolve to the lowest trait server-side)
-- ---------------------------------------------------------------------------

-- Quiz 1: "Which CAMPUS Legend Are You?" — 5 questions, 4 results.
with new_quiz as (
  insert into public.pulse_items (kind, category, body, version, status, evergreen)
  select 'quiz', 'campus_life', 'Which CAMPUS Legend Are You?', 1, 'approved', true
  where not exists (select 1 from public.pulse_items t where t.body = 'Which CAMPUS Legend Are You?' and t.kind = 'quiz')
  returning id
)
insert into public.pulse_quiz_questions (quiz_id, position, prompt, options)
select q.id, x.position, x.prompt, x.options::jsonb
from new_quiz q
join (values
  (1, 'It''s 9 PM the night before an internal. You are:',
   '[{"text":"Deep in revision already done earlier","trait":2},{"text":"Camera on, notes open, brain in hostel","trait":0},{"text":"Frantically messaging the class group","trait":1},{"text":"Watching one more video before starting","trait":3}]'),
  (2, 'Your ideal Saturday on campus is:',
   '[{"text":"Canteen, friends, canteen again","trait":0},{"text":"Serene library corner","trait":2},{"text":"Some event or fest prep","trait":1},{"text":"Sleep until the sun judges me","trait":3}]'),
  (3, 'When the campus Wi-Fi drops, you:',
   '[{"text":"Switch to data and keep the memes flowing","trait":1},{"text":"Mourn the lost lecture PDFs","trait":3},{"text":"Use it as a revision timeout","trait":2},{"text":"Discover three unverified developments in the canteen","trait":0}]'),
  (4, 'Your relationship with the 75% attendance line:',
   '[{"text":"Professional level: exactly 76%","trait":1},{"text":"We''ve never met (in a good way)","trait":2},{"text":"We coexist with monthly anxiety","trait":3},{"text":"Sponsor of the front bench","trait":0}]'),
  (5, 'The vendi machine moment: what do you grab?',
   '[{"text":"Whatever the group grabs","trait":1},{"text":"Filter coffee, obviously","trait":0},{"text":"Chips for the study grind","trait":2},{"text":"I bring my own snacks","trait":3}]')
) as x(position, prompt, options) on true;

insert into public.pulse_quiz_results (quiz_id, result_key, label, emoji, blurb)
select t.id, x.result_key, x.label, x.emoji, x.blurb
from public.pulse_items t
join (values
  (0, 'The Canteen Regular', '🍛', 'You know every table''s story and the wave queue by heart. The canteen is not a place — it''s your second hostel.'),
  (1, 'The Campus Social Butterfly', '🦋', 'Three group chats, two events, one legend. You connect the whole campus, one conversation at a time.'),
  (2, 'The Placement Warrior', '⚔️', 'LeetCode at lunch, CGPA before breakfast. Future you (well-paid) says thanks.'),
  (3, 'The Night-Owl Student', '🦉', 'Your best ideas arrive at 2 AM, usually the night before. It works — most of the time.')
) as x(result_key, label, emoji, blurb) on true
where t.body = 'Which CAMPUS Legend Are You?' and t.kind = 'quiz'
  and not exists (select 1 from public.pulse_quiz_results r where r.quiz_id = t.id);

-- Quiz 2: "What''s Your Study Season?" — 5 questions, 3 results.
with new_quiz as (
  insert into public.pulse_items (kind, category, body, version, status, evergreen)
  select 'quiz', 'exams', 'What''s Your Study Season?', 1, 'approved', true
  where not exists (select 1 from public.pulse_items t where t.body = 'What''s Your Study Season?' and t.kind = 'quiz')
  returning id
)
insert into public.pulse_quiz_questions (quiz_id, position, prompt, options)
select q.id, x.position, x.prompt, x.options::jsonb
from new_quiz q
join (values
  (1, 'Your notes are usually:',
   '[{"text":"Colour-coded masterpieces","trait":0},{"text":"Photos of a friend''s notes","trait":1},{"text":"What notes?","trait":2}]'),
  (2, 'A free study hall period means:',
   '[{"text":"Practice paper sprint","trait":0},{"text":"Group discussion chaos","trait":1},{"text":"Power nap of legends","trait":2}]'),
  (3, 'Exam countdown t-minus 3 days. Attack plan:',
   '[{"text":"The schedule is already 80% done","trait":0},{"text":"Divide the syllabus among friends","trait":1},{"text":"One heroic night decides everything","trait":2}]'),
  (4, 'Your phone during study hours:',
   '[{"text":"Grayscale, airplane mode, zen","trait":0},{"text":"Study group notifications only","trait":1},{"text":"It studies with me","trait":2}]'),
  (5, 'The topper asks to borrow YOUR notes. You:',
   '[{"text":"Hand them over proudly","trait":0},{"text":"Forward the group''s shared doc","trait":1},{"text":"Explain that my notes are a vibe, not a document","trait":2}]')
) as x(position, prompt, options) on true;

insert into public.pulse_quiz_results (quiz_id, result_key, label, emoji, blurb)
select t.id, x.result_key, x.label, x.emoji, x.blurb
from public.pulse_items t
join (values
  (0, 'The Process Prodigy', '📈', 'Systems, schedules, colour codes. Exams fear you more than you fear them.'),
  (1, 'The Squad Strategist', '🤝', 'You don''t study harder — you mobilise smarter. Your group chat is the real syllabus.'),
  (2, 'The Last-Minute Legend', '🔥', 'Pressure is your study fuel. It''s chaotic, it''s cinematic, it''s somehow working.')
) as x(result_key, label, emoji, blurb) on true
where t.body = 'What''s Your Study Season?' and t.kind = 'quiz'
  and not exists (select 1 from public.pulse_quiz_results r where r.quiz_id = t.id);

-- done: 12 questions · 14 statements · 2 quizzes (5×5+5×3, 4+3 results)
