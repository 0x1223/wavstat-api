import 'package:flutter/material.dart';

import 'screens/listener_screen.dart';

void main() {
  runApp(const KingzListenApp());
}

class KingzListenApp extends StatelessWidget {
  const KingzListenApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KINGZ LISTEN',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF070707),
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFD6A84F),
          brightness: Brightness.dark,
          surface: const Color(0xFF141414),
        ),
        fontFamily: 'Roboto',
        textTheme: ThemeData.dark().textTheme.apply(
              bodyColor: const Color(0xFFECECEC),
              displayColor: Colors.white,
            ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: const Color(0xFF0B0B0B),
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 14,
            vertical: 10,
          ),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF25211A)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF25211A)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFFD6A84F)),
          ),
          labelStyle: const TextStyle(color: Color(0xFF9B9B9B)),
        ),
      ),
      home: const ListenerScreen(),
    );
  }
}
