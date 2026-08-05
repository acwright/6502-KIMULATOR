6502-KIMULATOR
==============

The goal of this project is to create an emulator for the 6502-KIM which is a cousin of the KIM-1 for the AC6502 family of computers. An emulator for the family
already exists in the form of the 6502-EMULATOR project. This project should be a port of that project and share its functionality and architecture as much as possible (where appropriate) while
providing an entirely new UI for the KIM. We are replicating the KIM build-out not the KIM as an accessory to the ACE idea in the docs (don't bring along ACE only hardware emulation). 
This emulator will run the 6502-BIOS at its core just like the EMULATOR project.

The UI should be roughly laid out as follows: 
---------------------------------------------

----------------------------
|               |          |
|               |    LCD   |
|   Terminal    |          |
|               ------------
|               |          |
----------------|   KEYS   |
|               |          |
|   Accessory   |          |
|               |          |
----------------------------

- The UI should generally follow the theme of the main EMULATOR project
- While I want to retain the ability for this emulator to connect to a real serial port, one thing this UI adds is a built-in terminal you can type in since the serial card is an integral part of the KIM experience and KC Monitor software. White text on black. 40x24 characters. It should follow exactly what the serial port "sees"
- The keypad layout can be found in the DOCS under "The pad as it sits".
- The UI should retain buttons that are appropriate from the EMULATOR control bar
- The settings from EMULATOR should retain any items that are appropriate 
- The keys on the keypad should follow the color scheme of the real keypad. White on black keys or Black on white for some keys. See DOCS photo of keypad. Bebas Nueu font + icons.

- Open question: We need the keypad to accept keyboard input as well as the terminal. How do we handle this? Toggle between keyboard / pad?

Some UI work was done already in the past on a much older commit of EMULATOR (d8b7882444434440b5cd2ad0045fde2248c31588) before being removed. Namely, the LCD. I really liked the look of it. Use it as an example or bring it forward but don't trust any other code in that older emulation.

Accessories
-----------

The idea behind the accessories panel is to have a "breadboard" area just like on the real computer where potentially many accessories can be attached / detached from the machine. Essentially a plug-in system but not user developed or providable (at least not yet).
We will select from a dropdown or menu which accessory is "wired" to the bus. The first accessory is just eight LEDs driven by a 74HC373 latch. This area should not attempt to replicate a breadboard look but rather follow the UI conventions.

Other
-----

- Use a black text on white background 6502 icon to distinguish it from the main EMULATOR project's icon when see in applications folder for example.
- Open question: The CLI will need a new name. 6502-kim?

Create the plan
---------------

Create a multi-phase plan for this project and write it to PLAN.md in the project root. Don't forget to include creating README, LICENSE, and committing, tagging, building and deploying (Github release with summary) the initial version in the plan.

Resources
---------

- /Users/acwright/Developer/Kicad/6502-KIM - The hardware repo. This also contains the KC Monitor firmware ROM which will be needed for this emulator. The software we run (overlays BASIC and Monitor on BIOS).
- /Users/acwright/Developer/NodeJS/6502-EMULATOR - The emulator project for the family which will contain most of the code we need to port. Bring it over. At this point I don't want to use a shared library for both emulators.
- /Users/acwright/Developer/Assembly/6502-BIOS - The BIOS ROM that this project will run. The main source of truth for the whole family.
- /Users/acwright/Developer/NodeJS/6502-DOCS - Information about the ACE computer and the KIM. Also contains sample programs for the KIM as type-in cards (first accessory target). When this emulator lands it will be embedded in the docs (we will not be editing the DOCS project in this plan).
- /Users/acwright/Developer/NodeJS/bin2woz - CLI utility for generating Wozmon compatible code from binary. KC Monitor has a Wozmon compatible interface.
- /Users/acwright/Developer/Kicad/KIM Demo - The first accessory. A breadboard circuit with eight LED's driven by a 74HC373 latch that the DOCS refers to in "Two programs to type in".