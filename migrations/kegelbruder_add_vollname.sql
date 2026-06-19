-- Migration: vollname Spalte zur mitglieder-Tabelle hinzufügen
-- Quelle: DKB - Digitales Kegelbuch (Stammbuch + Gäste-Blätter)

ALTER TABLE mitglieder ADD COLUMN vollname TEXT;

-- Stammmitglieder
UPDATE mitglieder SET vollname = 'Fabian Kaletta'          WHERE name = 'Kalle';
UPDATE mitglieder SET vollname = 'Mike Plitzko'            WHERE name = 'Plitzko';
UPDATE mitglieder SET vollname = 'Mike Lichtblau'          WHERE name = 'Mike';
UPDATE mitglieder SET vollname = 'Mirko Lichtblau'         WHERE name = 'Mirko';
UPDATE mitglieder SET vollname = 'Daniel Fischer'          WHERE name = 'Fischer';
UPDATE mitglieder SET vollname = 'Steven Acheampong'       WHERE name = 'Steven';
UPDATE mitglieder SET vollname = 'Daniel Baier'            WHERE name = 'Dani';
UPDATE mitglieder SET vollname = 'Christian Scheuermann'   WHERE name = 'Scheuermann';
UPDATE mitglieder SET vollname = 'Markus v. Bestenbostel'  WHERE name = 'Akku';
UPDATE mitglieder SET vollname = 'Matthias Bierwirth'      WHERE name = 'Matti';
UPDATE mitglieder SET vollname = 'Nico Eberhard'           WHERE name = 'Nico';
UPDATE mitglieder SET vollname = 'Martin Arndt'            WHERE name = 'Maddin';
UPDATE mitglieder SET vollname = 'Lars Hoheisel'           WHERE name = 'Lars';
UPDATE mitglieder SET vollname = 'Sven Korzetz'            WHERE name = 'Sven';
UPDATE mitglieder SET vollname = 'Dominik Korzetz'         WHERE name = 'Domi';
UPDATE mitglieder SET vollname = 'Jan Korall'              WHERE name = 'Korall';
UPDATE mitglieder SET vollname = 'Oktawiusz Twardowski'    WHERE name = 'Oki';

-- Gäste
UPDATE mitglieder SET vollname = 'Nils Marquard'           WHERE name = 'Nils';
UPDATE mitglieder SET vollname = 'Marc Hoheisel'           WHERE name = 'Marc';
UPDATE mitglieder SET vollname = 'Salvatore Privitera'     WHERE name = 'Salve';
UPDATE mitglieder SET vollname = 'Hendrik Kastorf'         WHERE name = 'Henka';
UPDATE mitglieder SET vollname = 'Thomas Dorn'             WHERE name = 'Thommy';
UPDATE mitglieder SET vollname = 'Norbert Schneider'       WHERE name = 'Nobby';
UPDATE mitglieder SET vollname = 'Tristan Kloss'           WHERE name = 'Tristan';
UPDATE mitglieder SET vollname = 'Frederik Rodath'         WHERE name = 'Freddy';
UPDATE mitglieder SET vollname = 'Florian Koper'           WHERE name = 'Flo';
