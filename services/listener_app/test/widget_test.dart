import 'package:flutter_test/flutter_test.dart';

import 'package:kingz_listen/main.dart';

void main() {
  testWidgets('Kingz Listen app builds', (WidgetTester tester) async {
    await tester.pumpWidget(const KingzListenApp());
    expect(find.text('KINGZ LISTEN'), findsOneWidget);
  });
}
