// "What to say" for each side tab: the words Umbrella listens for, and example sentences
// (click one to put it in the message box). Copied from the companion playground.

export type SayHelp = { keywords: string[]; tip: string; examples: string[] };

export const SAY: Record<string, SayHelp> = {
  memory: {
    keywords: ["remember long term", "save it in memory", "forget", "what do you know about me"],
    tip: "Lasting facts: name, city, people, birthdays, likes, projects. Say where to save it, or Umbrella saves only when it is sure (otherwise it asks where).",
    examples: [
      "remember long term: my name is Rohan and I live in Pune",
      "remember long term: my mom's birthday is on 14 November",
      "remember long term that I'm allergic to peanuts",
      "when is my mom's birthday?",
      "what do you know about me?",
      "forget that I live in Pune",
    ],
  },
  short: {
    keywords: ["short term", "keep this for a few days", "forget"],
    tip: "Things for the next 10 days: payments, plans, how this week is going. They expire on their own.",
    examples: [
      "short term: I lent Karan 500 rupees today",
      "short term: I'm on a diet this week",
      "short term: my exam is on Friday",
      "how much did I lend Karan?",
      "what's in my short-term memory?",
      "forget the Karan payment",
    ],
  },
  notes: {
    keywords: ["note down", "note:", "write this down", "what was my …"],
    tip: "Notes keep exact text: passwords, codes, addresses, ideas. You can ask later in other words (\"internet code\" finds the wifi note).",
    examples: [
      "note down the wifi password: abc123",
      "note: Amit's address is 21 MG Road, Delhi",
      "note an idea: start sketching on weekends",
      "what's the internet code?",
      "what was Amit's address?",
      "delete the sketching note",
    ],
  },
  reminders: {
    keywords: ["remind me", "set a reminder", "full day", "every day / every Monday / every month", "move", "cancel", "done"],
    tip: "Say the day and the time; Umbrella asks for whichever is missing. Say \"full day\" for a reminder for the whole day (said at 9:00 that morning). Due reminders are spoken, with Done and 10-minute snooze buttons.",
    examples: [
      "remind me tonight at 8 to call mom",
      "remind me every day at 8 am to take vitamins",
      "remind me in 10 minutes to check the oven",
      "set a full day reminder on Monday: Riya's exam",
      "set a reminder to call the bank",
      "what reminders do I have?",
      "move the call-mom reminder to 9 pm",
      "cancel the gym reminder",
    ],
  },
  todos: {
    keywords: ["add to my to-do", "for tomorrow / for Friday", "done with …", "what do I have to do"],
    tip: "To-dos belong to a day (today if you don't say). Unfinished ones from earlier days show up as overdue.",
    examples: [
      "add to my to-do: pay the electricity bill, high priority",
      "add a to-do for tomorrow: book the car service",
      "what do I have to do today?",
      "what's planned for Friday?",
      "done with the electricity bill",
      "move the car service to Saturday",
    ],
  },
  lists: {
    keywords: ["add … to my … list", "bought / watched / packed", "what's on my … list", "clear my … list"],
    tip: "Any list by name: shopping, watchlist, packing, books. Clearing a list always asks yes/no first.",
    examples: [
      "add milk, eggs and bread to my shopping list",
      "add Dune to my watchlist",
      "what's left on my shopping list?",
      "I bought the milk and eggs",
      "remove bread from the shopping list",
      "clear my shopping list",
    ],
  },
  chat: {
    keywords: ["anything", "Hinglish or English", "search the web for …", "calculate …"],
    tip: "Just talk: Umbrella chats about anything, searches the web for live facts and does maths. The last 20 messages go to the LLM; older ones become a summary.",
    examples: [
      "I'm tired, too many meetings today",
      "give me a quick dinner idea without peanuts",
      "what's the weather in Pune today?",
      "how many steps a day are healthy?",
      "what is 18% of 1200?",
      "kal ka plan kya hai?",
    ],
  },
};
