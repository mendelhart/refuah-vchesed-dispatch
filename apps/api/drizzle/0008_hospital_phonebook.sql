-- The hospital phone book: real-world reference data, not user data. Seeded
-- once by migration so every fresh deployment has it, and a dispatcher's
-- later edits or deletions are their own (nothing re-seeds these rows).
WITH a AS (
  INSERT INTO addresses (line1, city, province, postal_code, country)
  VALUES
  ('3755 Chemin de la Côte-Sainte-Catherine', 'Montreal', 'QC', 'H3T 1E2', 'CA'),
  ('3830 Avenue Lacombe', 'Montreal', 'QC', 'H3T 1M5', 'CA'),
  ('1650 Avenue Cedar', 'Montreal', 'QC', 'H3G 1A4', 'CA'),
  ('1001 Boulevard Décarie', 'Montreal', 'QC', 'H4A 3J1', 'CA'),
  ('1001 Boulevard Décarie', 'Montreal', 'QC', 'H4A 3J1', 'CA'),
  ('1000 Rue Saint-Denis', 'Montreal', 'QC', 'H2X 0C1', 'CA'),
  ('5400 Boulevard Gouin Ouest', 'Montreal', 'QC', 'H4J 1C5', 'CA'),
  ('3175 Chemin de la Côte-Sainte-Catherine', 'Montreal', 'QC', 'H3T 1C5', 'CA'),
  ('5415 Boulevard de l''Assomption', 'Montreal', 'QC', 'H1T 2M4', 'CA'),
  ('160 Avenue Stillview', 'Pointe-Claire', 'QC', 'H9R 2Y2', 'CA'),
  ('4000 Boulevard LaSalle', 'Verdun', 'QC', 'H4G 2A3', 'CA'),
  ('5795 Avenue Caldwell', 'Côte-Saint-Luc', 'QC', 'H4W 1W3', 'CA'),
  ('5655 Rue Saint-Zotique Est', 'Montreal', 'QC', 'H1T 1N5', 'CA'),
  ('5690 Boulevard Cavendish', 'Côte-Saint-Luc', 'QC', 'H4W 1S7', 'CA'),
  ('5000 Rue Bélanger', 'Montreal', 'QC', 'H1T 1C8', 'CA'),
  ('1385 Rue Jean-Talon Est', 'Montreal', 'QC', 'H2E 1S6', 'CA'),
  ('6875 Boulevard LaSalle', 'Verdun', 'QC', 'H4H 1R3', 'CA')
  RETURNING id, line1
)
INSERT INTO contacts (name, phone, role, address_id)
SELECT v.name, v.phone, 'Hospital', a.id
FROM (VALUES
  ('Jewish General Hospital', '+15143408222', '3755 Chemin de la Côte-Sainte-Catherine'),
  ('St. Mary''s Hospital Center', '+15143453511', '3830 Avenue Lacombe'),
  ('Montreal General Hospital (MUHC)', '+15149341934', '1650 Avenue Cedar'),
  ('MUHC Glen site (Royal Victoria)', '+15149341934', '1001 Boulevard Décarie'),
  ('Montreal Children''s Hospital', '+15144124400', '1001 Boulevard Décarie'),
  ('CHUM (Centre hospitalier de l''Université de Montréal)', '+15148908000', '1000 Rue Saint-Denis'),
  ('Hôpital du Sacré-Cœur de Montréal', '+15143382222', '5400 Boulevard Gouin Ouest'),
  ('CHU Sainte-Justine', '+15143454931', '3175 Chemin de la Côte-Sainte-Catherine'),
  ('Hôpital Maisonneuve-Rosemont', '+15142523400', '5415 Boulevard de l''Assomption'),
  ('Lakeshore General Hospital', '+15146302225', '160 Avenue Stillview'),
  ('Hôpital de Verdun', '+15143621000', '4000 Boulevard LaSalle'),
  ('Maimonides Geriatric Centre', '+15144832121', '5795 Avenue Caldwell'),
  ('Hôpital Santa Cabrini', '+15142526000', '5655 Rue Saint-Zotique Est'),
  ('Mount Sinai Hospital', '+15143692222', '5690 Boulevard Cavendish'),
  ('Montreal Heart Institute', '+15143763330', '5000 Rue Bélanger'),
  ('Hôpital Jean-Talon', '+15144956767', '1385 Rue Jean-Talon Est'),
  ('Douglas Mental Health University Institute', '+15147616131', '6875 Boulevard LaSalle')
) AS v(name, phone, line1)
JOIN a ON a.line1 = v.line1;
